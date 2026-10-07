import * as readline from "readline";
import type { OAuth2Client } from "google-auth-library";
import { getAuthenticatedClient, getCredentialsPath, isAuthError } from "./auth.js";
import { fetchUpcomingMeetings, getNextPollTime } from "./calendar.js";
import { MeetingTracker } from "./meeting-tracker.js";
import { showAuthFailureNotification } from "./notifications.js";
import { createLogger } from "./logger.js";
import type { Config, Logger, MeetingEvent } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * Parse command line arguments into configuration.
 */
function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = { ...DEFAULT_CONFIG };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-v":
      case "--verbose":
        config.verbose = true;
        break;

      case "--only-accepted":
        config.onlyAcceptedEvents = true;
        break;

      case "--notify-minutes":
        const minutes = parseInt(args[++i], 10);
        if (isNaN(minutes) || minutes < 1 || minutes > 15) {
          console.error("--notify-minutes must be between 1 and 15");
          process.exit(1);
        }
        config.notifyMinutesBefore = minutes;
        break;

      case "-h":
      case "--help":
        printHelp();
        process.exit(0);

      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return config;
}

/**
 * Print help information.
 */
function printHelp(): void {
  console.log(`
Calendar Alert - Meeting notifier with auto-join

Usage: npm start [options]

Options:
  -v, --verbose        Enable verbose logging
  --only-accepted      Only notify for events you've accepted
  --notify-minutes N   Minutes before meeting to notify (1-15, default: 2)
  -h, --help           Show this help message

Setup:
  1. Create a Google Cloud project and enable Calendar API
  2. Create OAuth credentials (Desktop app type)
  3. Download credentials.json to: ${getCredentialsPath()}
  4. Run this program and authorize in the browser

The program will check for meetings every ~15 minutes, aligned to quarter hours.
When a meeting with a Zoom, Teams, or Google Meet link is found, you'll get a
notification with options to auto-join or dismiss.
`);
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find meetings in the current 15-minute block that are eligible for manual commands.
 * "Current block" means: from now until the end of the current 15-minute interval.
 */
function getMeetingsInCurrentBlock(meetings: MeetingEvent[]): MeetingEvent[] {
  const now = new Date();
  const blockEnd = new Date(now);
  // Round up to the next 15-minute mark
  const minutesToNext15 = 15 - (now.getMinutes() % 15);
  blockEnd.setMinutes(now.getMinutes() + minutesToNext15);
  blockEnd.setSeconds(0);
  blockEnd.setMilliseconds(0);

  return meetings.filter(
    (m) => m.startTime >= now && m.startTime <= blockEnd,
  );
}

/**
 * Set up line-mode keyboard input for manual look/join commands.
 */
function setupKeyboardInput(
  auth: OAuth2Client,
  config: Config,
  tracker: MeetingTracker,
  logger: Logger,
): void {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    const cmd = line.trim().toLowerCase();

    if (cmd === "l") {
      logger.info("Manual look: fetching meetings...");
      try {
        const meetings = await fetchUpcomingMeetings(auth, config, logger);
        const inBlock = getMeetingsInCurrentBlock(meetings);
        if (inBlock.length === 0) {
          logger.info("No meetings found in the current 15-minute block.");
        } else {
          await tracker.processMeetings(inBlock);
        }
      } catch (error) {
        logger.error("Error fetching meetings", error);
      }
    } else if (cmd === "j") {
      logger.info("Manual join: fetching meetings...");
      try {
        const meetings = await fetchUpcomingMeetings(auth, config, logger);
        const inBlock = getMeetingsInCurrentBlock(meetings);

        if (inBlock.length === 0) {
          logger.info("No meetings found in the current 15-minute block.");
          return;
        }

        // Clear dismissed state so 'j' can un-dismiss
        for (const meeting of inBlock) {
          tracker.clearDismissed(meeting.id);
        }

        // Filter to meetings not already scheduled or joined
        const tracked = tracker.getTrackedMeetings();
        const trackedIds = new Set(
          tracked
            .filter((t) => t.status === "scheduled_join" || t.status === "joined")
            .map((t) => t.event.id),
        );
        const eligible = inBlock.filter((m) => !trackedIds.has(m.id));

        if (eligible.length === 0) {
          logger.info("No eligible meetings — already scheduled or joined.");
        } else if (eligible.length > 1) {
          logger.info(
            `Found ${eligible.length} meetings — use 'l' to pick one:`,
          );
          for (const m of eligible) {
            logger.info(`  • ${m.summary} at ${m.startTime.toLocaleTimeString()}`);
          }
        } else {
          tracker.scheduleAutoJoinDirect(eligible[0]);
        }
      } catch (error) {
        logger.error("Error fetching meetings", error);
      }
    }
  });

  logger.info("Commands: 'l' + Enter to look ahead, 'j' + Enter to auto-join");
}

/**
 * Handle a fatal authentication failure: alert the user with a popup (since
 * the app may be running in the background and logs may go unseen) and
 * shut down, since the app can't recover from this without a restart.
 */
async function handleAuthFailure(
  tracker: MeetingTracker,
  logger: Logger,
): Promise<void> {
  logger.error("Authentication has failed. Please restart the app and re-authenticate.");
  await showAuthFailureNotification(logger);
  tracker.shutdown();
  process.exit(1);
}

/**
 * Main polling loop.
 */
async function runPollingLoop(
  auth: OAuth2Client,
  config: Config,
  logger: Logger,
): Promise<void> {
  const tracker = new MeetingTracker(config, logger);

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    tracker.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  setupKeyboardInput(auth, config, tracker, logger);

  logger.info("Calendar Alert started. Watching for meetings...");
  logger.info(`Notify ${config.notifyMinutesBefore} minutes before meetings`);
  if (config.onlyAcceptedEvents) {
    logger.info("Only showing accepted events");
  }

  // Do an initial poll immediately
  try {
    const meetings = await fetchUpcomingMeetings(auth, config, logger);
    await tracker.processMeetings(meetings);
  } catch (error) {
    logger.error("Error fetching meetings", error);
    if (isAuthError(error)) {
      await handleAuthFailure(tracker, logger);
    }
  }

  // Then poll on schedule
  while (true) {
    const nextPoll = getNextPollTime(config.notifyMinutesBefore);
    const waitTime = nextPoll.getTime() - Date.now();

    logger.info(`Next poll at ${nextPoll.toLocaleTimeString()}`);

    await sleep(waitTime);

    try {
      const meetings = await fetchUpcomingMeetings(auth, config, logger);
      await tracker.processMeetings(meetings);
    } catch (error) {
      logger.error("Error fetching meetings", error);
      if (isAuthError(error)) {
        await handleAuthFailure(tracker, logger);
      }
      // Continue polling even if there's a non-auth error
    }
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const config = parseArgs();
  const logger = createLogger(config.verbose);

  logger.info("Authenticating with Google Calendar...");

  try {
    const auth = await getAuthenticatedClient(logger);
    await runPollingLoop(auth, config, logger);
  } catch (error) {
    logger.error("Fatal error", error);
    if (isAuthError(error)) {
      await showAuthFailureNotification(logger);
    }
    process.exit(1);
  }
}

main();

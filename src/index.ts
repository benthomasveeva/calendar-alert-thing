import type { OAuth2Client } from "google-auth-library";
import { getAuthenticatedClient, getCredentialsPath } from "./auth.js";
import { fetchUpcomingMeetings, getNextPollTime } from "./calendar.js";
import { MeetingTracker } from "./meeting-tracker.js";
import { createLogger } from "./logger.js";
import type { Config, Logger } from "./types.js";
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
      // Continue polling even if there's an error
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
    process.exit(1);
  }
}

main();

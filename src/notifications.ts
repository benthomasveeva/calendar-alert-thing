import { execFile } from "child_process";
import { promisify } from "util";
import type { MeetingEvent, NotificationAction, Logger } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Format a meeting time for display.
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Show a macOS notification with action buttons.
 * Returns the user's action: "join" if they clicked the action button,
 * "dismiss" if they clicked the close button or dismissed it.
 *
 * Uses AppleScript to show a dialog with buttons since native notifications
 * don't support reliable action callbacks.
 */
export async function showMeetingNotification(
  event: MeetingEvent,
  logger: Logger
): Promise<NotificationAction> {
  const startTime = formatTime(event.startTime);
  const platformName =
    event.meetingLink.platform.charAt(0).toUpperCase() +
    event.meetingLink.platform.slice(1);

  const title = `Upcoming Meeting: ${event.summary}`;
  const message = `${platformName} meeting starts at ${startTime}`;

  // Calculate seconds until meeting start so the dialog stays open until then
  const secondsUntilStart = Math.max(
    1,
    Math.ceil((event.startTime.getTime() - Date.now()) / 1000)
  );

  // Use AppleScript to show a dialog with buttons
  // This allows us to capture which button was clicked
  const appleScript = `
    tell application "System Events"
      display dialog "${message.replace(/"/g, '\\"')}" ¬
        with title "${title.replace(/"/g, '\\"')}" ¬
        buttons {"Dismiss", "Auto-Join"} ¬
        default button "Auto-Join" ¬
        giving up after ${secondsUntilStart}
    end tell
  `;

  logger.verbose(`Showing notification for: ${event.summary} (timeout: ${secondsUntilStart}s)`);

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", appleScript]);

    // Parse the AppleScript result
    // Result looks like: "button returned:Auto-Join, gave up:false"
    if (stdout.includes("Auto-Join")) {
      logger.info(`User chose to auto-join: ${event.summary}`);
      return "join";
    } else if (stdout.includes("gave up:true")) {
      logger.verbose(`Notification timed out for: ${event.summary}`);
      return "timeout";
    } else {
      logger.verbose(`User dismissed notification for: ${event.summary}`);
      return "dismiss";
    }
  } catch (error) {
    // User closed the dialog or hit Escape
    logger.verbose(`Notification dismissed (closed) for: ${event.summary}`);
    return "dismiss";
  }
}

/**
 * Show a simple notification without action buttons.
 * Used for informational messages.
 */
export async function showSimpleNotification(
  title: string,
  message: string,
  logger: Logger
): Promise<void> {
  const appleScript = `
    display notification "${message.replace(/"/g, '\\"')}" ¬
      with title "${title.replace(/"/g, '\\"')}"
  `;

  try {
    await execFileAsync("osascript", ["-e", appleScript]);
    logger.verbose(`Showed notification: ${title}`);
  } catch (error) {
    logger.error("Failed to show notification", error);
  }
}

/**
 * Show a blocking dialog alerting the user that authentication has failed.
 * Unlike showSimpleNotification, this uses a dialog (not a banner) so it's
 * much more likely to be seen even if the app is running in the background.
 */
export async function showAuthFailureNotification(logger: Logger): Promise<void> {
  const title = "Calendar Alert: Authentication Failed";
  const message =
    "Calendar Alert lost access to your Google Calendar and can't check for meetings. Please restart the app and re-authenticate.";

  const appleScript = `
    tell application "System Events"
      display dialog "${message.replace(/"/g, '\\"')}" ¬
        with title "${title.replace(/"/g, '\\"')}" ¬
        buttons {"OK"} ¬
        default button "OK" ¬
        with icon caution
    end tell
  `;

  logger.verbose("Showing auth failure notification");

  try {
    await execFileAsync("osascript", ["-e", appleScript]);
  } catch (error) {
    logger.error("Failed to show auth failure notification", error);
  }
}

/**
 * Show a notification when auto-joining a meeting.
 */
export async function showJoiningNotification(
  event: MeetingEvent,
  logger: Logger
): Promise<void> {
  await showSimpleNotification(
    "Joining Meeting",
    `Opening ${event.meetingLink.platform}: ${event.summary}`,
    logger
  );
}

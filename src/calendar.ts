import { google, calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type {
  MeetingEvent,
  MeetingLink,
  MeetingPlatform,
  Config,
  Logger,
} from "./types.js";

/** Patterns to extract meeting links from event descriptions and locations */
const MEETING_PATTERNS: Record<MeetingPlatform, RegExp> = {
  zoom: /https:\/\/[\w.-]*zoom\.us\/j\/[\w?=&-]+/gi,
  teams:
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[\w%\-/.]+(\?context=[^"\s<>]+)?/gi,
  meet: /https:\/\/meet\.google\.com\/[\w-]+/gi,
};

/**
 * Extract meeting link from event data.
 * Checks conferenceData first, then description/location.
 */
function extractMeetingLink(
  event: calendar_v3.Schema$Event,
): MeetingLink | null {
  // First, check conferenceData (most reliable for Google Meet and some Zoom integrations)
  if (event.conferenceData?.entryPoints) {
    for (const entryPoint of event.conferenceData.entryPoints) {
      if (entryPoint.entryPointType === "video" && entryPoint.uri) {
        const uri = entryPoint.uri;

        if (uri.includes("zoom.us")) {
          return { platform: "zoom", url: uri };
        }
        if (uri.includes("teams.microsoft.com")) {
          return { platform: "teams", url: uri };
        }
        if (uri.includes("meet.google.com")) {
          return { platform: "meet", url: uri };
        }
      }
    }
  }

  // Then search in description and location
  const textToSearch = [event.description, event.location]
    .filter(Boolean)
    .join(" ");

  for (const [platform, pattern] of Object.entries(MEETING_PATTERNS)) {
    // Reset regex lastIndex since we're reusing them
    pattern.lastIndex = 0;
    const match = pattern.exec(textToSearch);
    if (match) {
      return { platform: platform as MeetingPlatform, url: match[0] };
    }
  }

  return null;
}

/**
 * Parse event start time to a Date object.
 * Handles both dateTime (timed events) and date (all-day events).
 */
function parseEventTime(
  eventTime: calendar_v3.Schema$EventDateTime | undefined,
): Date | null {
  if (!eventTime) return null;

  if (eventTime.dateTime) {
    return new Date(eventTime.dateTime);
  }

  if (eventTime.date) {
    return new Date(eventTime.date);
  }

  return null;
}

/**
 * Get the current user's response status for an event.
 */
function getResponseStatus(
  event: calendar_v3.Schema$Event,
): calendar_v3.Schema$EventAttendee["responseStatus"] {
  // If there are no attendees, assume it's the user's own event (accepted)
  if (!event.attendees || event.attendees.length === 0) {
    return "accepted";
  }

  // Find the attendee marked as 'self'
  const selfAttendee = event.attendees.find((a) => a.self === true);
  return selfAttendee?.responseStatus;
}

/**
 * Convert a Google Calendar event to our MeetingEvent type.
 */
function toMeetingEvent(event: calendar_v3.Schema$Event): MeetingEvent | null {
  if (!event.id || !event.summary) {
    return null;
  }

  const startTime = parseEventTime(event.start);
  const endTime = parseEventTime(event.end);

  if (!startTime || !endTime) {
    return null;
  }

  const meetingLink = extractMeetingLink(event);
  if (!meetingLink) {
    return null;
  }

  return {
    id: event.id,
    summary: event.summary,
    startTime,
    endTime,
    meetingLink,
    responseStatus: getResponseStatus(event),
    originalEvent: event,
  };
}

/**
 * Fetch upcoming calendar events with video meeting links.
 * Returns events starting within the specified time window.
 */
export async function fetchUpcomingMeetings(
  auth: OAuth2Client,
  config: Config,
  logger: Logger,
): Promise<MeetingEvent[]> {
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  // Look ahead 15 minutes to catch upcoming meetings
  const maxTime = new Date(now.getTime() + 15 * 60 * 1000);

  logger.verbose(
    `Fetching events from ${now.toISOString()} to ${maxTime.toISOString()}`,
  );

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: maxTime.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data?.items || [];
  logger.verbose(`Found ${events.length} total events in time window`);

  const meetingEvents: MeetingEvent[] = [];

  for (const event of events) {
    const meetingEvent = toMeetingEvent(event);

    if (!meetingEvent) {
      continue;
    }

    // Filter by acceptance status if configured
    if (config.onlyAcceptedEvents) {
      if (meetingEvent.responseStatus !== "accepted") {
        logger.verbose(
          `Skipping "${meetingEvent.summary}" - not accepted (status: ${meetingEvent.responseStatus})`,
        );
        continue;
      }
    }

    meetingEvents.push(meetingEvent);
    logger.verbose(
      `Found meeting: "${meetingEvent.summary}" at ${meetingEvent.startTime.toLocaleTimeString()} (${meetingEvent.meetingLink.platform})`,
    );
  }

  return meetingEvents;
}

/**
 * Calculate the next poll time based on quarter-hour alignment.
 * Polls at :13, :28, :43, :58 to catch meetings at :15, :30, :45, :00.
 */
export function getNextPollTime(notifyMinutesBefore: number): Date {
  const now = new Date();
  const currentMinute = now.getMinutes();

  // Target minutes to poll at (2 minutes before quarter hours by default)
  // Adjustable based on notifyMinutesBefore setting
  const offset = notifyMinutesBefore;
  const pollMinutes = [15 - offset, 30 - offset, 45 - offset, 60 - offset].map(
    (m) => (m + 60) % 60,
  );

  // Find the next poll minute
  let nextMinute = pollMinutes.find((m) => m > currentMinute);

  const nextPoll = new Date(now);
  nextPoll.setSeconds(0);
  nextPoll.setMilliseconds(0);

  if (nextMinute !== undefined) {
    nextPoll.setMinutes(nextMinute);
  } else {
    // Wrap to next hour
    nextPoll.setHours(nextPoll.getHours() + 1);
    nextPoll.setMinutes(pollMinutes[0]);
  }

  return nextPoll;
}

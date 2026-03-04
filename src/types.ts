import type { calendar_v3 } from "googleapis";

/** Configuration for the calendar alert application */
export interface Config {
  /** Minutes before meeting to show notification (default: 2) */
  notifyMinutesBefore: number;
  /** Whether to only include accepted events (vs all events with video links) */
  onlyAcceptedEvents: boolean;
  /** Enable verbose logging */
  verbose: boolean;
}

/** Default configuration values */
export const DEFAULT_CONFIG: Config = {
  notifyMinutesBefore: 2,
  onlyAcceptedEvents: false,
  verbose: false,
};

/** Supported video meeting platforms */
export type MeetingPlatform = "zoom" | "teams" | "meet";

/** Extracted meeting link information */
export interface MeetingLink {
  platform: MeetingPlatform;
  url: string;
}

/** A calendar event with a video meeting link */
export interface MeetingEvent {
  id: string;
  summary: string;
  startTime: Date;
  endTime: Date;
  meetingLink: MeetingLink;
  /** The user's response status to this event */
  responseStatus: calendar_v3.Schema$EventAttendee["responseStatus"];
  /** Original Google Calendar event for reference */
  originalEvent: calendar_v3.Schema$Event;
}

/** Status of a tracked meeting */
export type MeetingStatus =
  | "pending" // Not yet notified
  | "notified" // Notification shown, waiting for user response
  | "scheduled_join" // User chose to auto-join
  | "dismissed" // User dismissed the notification
  | "joined" // Meeting link was opened
  | "expired"; // Meeting start time passed without action

/** A meeting being tracked by the application */
export interface TrackedMeeting {
  event: MeetingEvent;
  status: MeetingStatus;
  notifiedAt?: Date;
  scheduledJoinAt?: Date;
}

/** Result of a notification action */
export type NotificationAction = "join" | "dismiss" | "timeout";

/** Logger interface for different verbosity levels */
export interface Logger {
  info(message: string): void;
  verbose(message: string): void;
  error(message: string, error?: unknown): void;
}

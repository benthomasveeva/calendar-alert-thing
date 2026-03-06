import open from "open";
import type {
  MeetingEvent,
  TrackedMeeting,
  MeetingStatus,
  Config,
  Logger,
} from "./types.js";
import {
  showMeetingNotification,
  showJoiningNotification,
} from "./notifications.js";

/**
 * Manages the state of meetings and handles notifications and auto-joining.
 */
export class MeetingTracker {
  private trackedMeetings: Map<string, TrackedMeeting> = new Map();
  private joinTimers: Map<string, NodeJS.Timeout> = new Map();
  private config: Config;
  private logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Process newly fetched meetings and update tracking state.
   */
  async processMeetings(meetings: MeetingEvent[]): Promise<void> {
    const now = new Date();

    for (const meeting of meetings) {
      const existing = this.trackedMeetings.get(meeting.id);

      // Skip if we've already processed this meeting
      if (existing && existing.status !== "pending") {
        continue;
      }

      // Check if it's time to notify (within notify window)
      const timeUntilStart = meeting.startTime.getTime() - now.getTime();
      const notifyWindowMs = this.config.notifyMinutesBefore * 60 * 1000;

      if (timeUntilStart <= notifyWindowMs && timeUntilStart > 0) {
        // Time to notify about this meeting
        if (!existing) {
          this.trackedMeetings.set(meeting.id, {
            event: meeting,
            status: "pending",
          });
        }

        await this.notifyForMeeting(meeting);
      }
    }

    // Clean up old meetings that have passed
    this.cleanupExpiredMeetings();
  }

  /**
   * Show notification for a meeting and handle the user's response.
   */
  private async notifyForMeeting(meeting: MeetingEvent): Promise<void> {
    const tracked = this.trackedMeetings.get(meeting.id);
    if (!tracked || tracked.status !== "pending") {
      return;
    }

    // Update status to notified
    this.updateStatus(meeting.id, "notified");

    // Show the notification (this blocks until user responds or timeout)
    const action = await showMeetingNotification(meeting, this.logger);

    switch (action) {
      case "join":
        this.scheduleAutoJoin(meeting);
        break;
      case "dismiss":
        this.updateStatus(meeting.id, "dismissed");
        this.logger.info(`Dismissed: ${meeting.summary}`);
        break;
      case "timeout":
        // On timeout, treat as dismissed
        this.updateStatus(meeting.id, "dismissed");
        break;
    }
  }

  /**
   * Schedule auto-join for a meeting at its start time.
   */
  private scheduleAutoJoin(meeting: MeetingEvent): void {
    const now = new Date();
    const delay = meeting.startTime.getTime() - now.getTime();

    if (delay <= 0) {
      // Meeting already started, join immediately
      this.joinMeeting(meeting);
      return;
    }

    this.updateStatus(meeting.id, "scheduled_join");
    this.logger.info(
      `Scheduled auto-join for "${meeting.summary}" at ${meeting.startTime.toLocaleTimeString()}`
    );

    const timer = setTimeout(() => {
      this.joinMeeting(meeting);
    }, delay);

    this.joinTimers.set(meeting.id, timer);
  }

  /**
   * Open the meeting link in the default browser.
   */
  private async joinMeeting(meeting: MeetingEvent): Promise<void> {
    this.updateStatus(meeting.id, "joined");
    this.logger.info(`Joining meeting: ${meeting.summary}`);

    // Show a brief notification
    await showJoiningNotification(meeting, this.logger);

    // Open the meeting link
    try {
      await open(meeting.meetingLink.url);
      this.logger.info(
        `Opened ${meeting.meetingLink.platform} link for: ${meeting.summary}`
      );
    } catch (error) {
      this.logger.error(`Failed to open meeting link: ${meeting.summary}`, error);
    }

    // Clean up timer reference
    this.joinTimers.delete(meeting.id);
  }

  /**
   * Update the status of a tracked meeting.
   */
  private updateStatus(meetingId: string, status: MeetingStatus): void {
    const tracked = this.trackedMeetings.get(meetingId);
    if (tracked) {
      tracked.status = status;
      if (status === "notified") {
        tracked.notifiedAt = new Date();
      }
      if (status === "scheduled_join") {
        tracked.scheduledJoinAt = new Date();
      }
    }
  }

  /**
   * Clean up meetings that have already started and weren't scheduled for join.
   */
  private cleanupExpiredMeetings(): void {
    const now = new Date();
    const expireThreshold = 5 * 60 * 1000; // 5 minutes after start

    for (const [id, tracked] of this.trackedMeetings.entries()) {
      const timeSinceStart = now.getTime() - tracked.event.startTime.getTime();

      // Remove meetings that started more than 5 minutes ago and aren't scheduled for join
      if (
        timeSinceStart > expireThreshold &&
        tracked.status !== "scheduled_join"
      ) {
        this.trackedMeetings.delete(id);
        this.logger.verbose(`Cleaned up expired meeting: ${tracked.event.summary}`);
      }
    }
  }

  /**
   * Schedule auto-join for a meeting directly, without showing a notification.
   * Used by the manual 'j' command.
   */
  scheduleAutoJoinDirect(meeting: MeetingEvent): void {
    this.trackedMeetings.set(meeting.id, {
      event: meeting,
      status: "pending",
    });
    this.scheduleAutoJoin(meeting);
  }

  /**
   * Clear dismissed status for a meeting so it can be re-evaluated.
   * Used by the manual 'j' command to allow un-dismissing.
   */
  clearDismissed(meetingId: string): void {
    const tracked = this.trackedMeetings.get(meetingId);
    if (tracked?.status === "dismissed") {
      this.trackedMeetings.delete(meetingId);
    }
  }

  /**
   * Get the current status of all tracked meetings.
   */
  getTrackedMeetings(): TrackedMeeting[] {
    return Array.from(this.trackedMeetings.values());
  }

  /**
   * Cancel all pending auto-joins and clean up.
   */
  shutdown(): void {
    for (const [id, timer] of this.joinTimers.entries()) {
      clearTimeout(timer);
      this.logger.verbose(`Cancelled auto-join timer for meeting ${id}`);
    }
    this.joinTimers.clear();
    this.trackedMeetings.clear();
  }
}

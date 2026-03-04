# Calendar Alert

A CLI tool that monitors your Google Calendar for upcoming meetings with Zoom, Teams, or Google Meet links. Shows a notification 2 minutes before meetings and lets you auto-join when the meeting starts.

## Features

- Polls Google Calendar aligned to quarter-hours (minimal API usage)
- Detects Zoom, Microsoft Teams, and Google Meet links
- macOS notifications with "Auto-Join" and "Dismiss" buttons
- Opens meeting links in your default browser at the meeting start time
- Configurable notification timing
- Option to only show accepted meetings

## Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Calendar API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Calendar API"
   - Click "Enable"

### 2. Create OAuth Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. If prompted, configure the OAuth consent screen:
   - Choose "Internal" (for Workspace) or "External"
   - Fill in required fields (app name, support email)
   - Add scope: `https://www.googleapis.com/auth/calendar.readonly`
4. For Application type, select "Desktop app"
5. Download the credentials JSON file

### 3. Install Credentials

Save the downloaded credentials file to:

```
~/.config/calendar-alert/credentials.json
```

Create the directory if it doesn't exist:

```bash
mkdir -p ~/.config/calendar-alert
mv ~/Downloads/client_secret_*.json ~/.config/calendar-alert/credentials.json
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Build and Run

```bash
npm run build
npm start
```

On first run, a browser window will open for Google authorization. After authorizing, tokens are saved locally and you won't need to re-authorize unless they expire.

## Usage

```
npm start [options]

Options:
  -v, --verbose        Enable verbose logging
  --only-accepted      Only notify for events you've accepted
  --notify-minutes N   Minutes before meeting to notify (1-15, default: 2)
  -h, --help           Show this help message
```

### Examples

```bash
# Run with default settings (2-minute notifications)
npm start

# Verbose mode for debugging
npm start -- -v

# Only show meetings you've accepted
npm start -- --only-accepted

# Notify 5 minutes before meetings
npm start -- --notify-minutes 5

# Combine options
npm start -- -v --only-accepted --notify-minutes 3
```

## How It Works

1. The program authenticates with your Google Calendar
2. It polls your primary calendar at :13, :28, :43, :58 (2 minutes before quarter-hours by default)
3. When a meeting with a video link is found within the notification window:
   - A dialog appears with the meeting name and time
   - Click "Auto-Join" to have it open the meeting link when the meeting starts
   - Click "Dismiss" to ignore this meeting
4. At the scheduled meeting time, the meeting link opens in your default browser

## Development

```bash
# Run without building (uses tsx)
npm run dev

# Build TypeScript
npm run build
```

## File Locations

- Credentials: `~/.config/calendar-alert/credentials.json`
- OAuth tokens: `~/.config/calendar-alert/token.json`

## Troubleshooting

### "Failed to load credentials" error

Make sure you've downloaded the OAuth credentials and saved them to the correct location.

### Authorization fails

- Ensure the Calendar API is enabled in your Google Cloud project
- Check that the redirect URI includes `http://localhost:3000/oauth2callback`
- For work accounts, you may need to have your Google Workspace admin approve the OAuth consent screen

### Notifications don't appear

- Check System Preferences > Notifications to ensure Terminal (or your terminal app) can show notifications
- The notifications use AppleScript dialogs which should work without additional permissions

### Meeting links not detected

The program looks for:
- Zoom: `https://*.zoom.us/j/*`
- Teams: `https://teams.microsoft.com/l/meetup-join/*`
- Google Meet: `https://meet.google.com/*`

Links can be in the event's conference data, description, or location fields.

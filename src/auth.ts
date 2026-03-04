import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import * as fs from "fs/promises";
import * as path from "path";
import * as http from "http";
import * as url from "url";
import type { Logger } from "./types.js";

/** OAuth scopes required for reading calendar events */
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

/** Path to store OAuth tokens */
const TOKEN_PATH = path.join(
  process.env.HOME || "~",
  ".config",
  "calendar-alert",
  "token.json",
);

/** Path to OAuth client credentials */
const CREDENTIALS_PATH = path.join(
  process.env.HOME || "~",
  ".config",
  "calendar-alert",
  "credentials.json",
);

/** Structure of the credentials.json file from Google Cloud Console */
interface ClientCredentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

/**
 * Load OAuth client credentials from the credentials file.
 */
async function loadCredentials(): Promise<ClientCredentials> {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(content) as ClientCredentials;
  } catch (error) {
    throw new Error(
      `Failed to load credentials from ${CREDENTIALS_PATH}. ` +
        `Please download your OAuth credentials from Google Cloud Console and save them there.\n` +
        `See README.md for setup instructions.`,
    );
  }
}

/**
 * Load saved tokens if they exist.
 */
async function loadSavedTokens(): Promise<Credentials | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(content) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Save tokens to disk for future use.
 */
async function saveTokens(tokens: Credentials): Promise<void> {
  const dir = path.dirname(TOKEN_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

/**
 * Start a local server to receive the OAuth callback.
 * Returns the authorization code.
 */
function waitForAuthCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || "", true);

      if (parsedUrl.pathname === "/oauth2callback") {
        const code = parsedUrl.query.code as string | undefined;
        const error = parsedUrl.query.error as string | undefined;

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`,
          );
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authorization successful!</h1><p>You can close this window and return to the terminal.</p></body></html>`,
          );
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.listen(port, () => {
      // Server started
    });

    server.on("error", reject);
  });
}

/**
 * Perform OAuth authorization flow.
 * Opens a browser for the user to authorize, then captures the callback.
 */
async function authorize(
  oauth2Client: OAuth2Client,
  logger: Logger,
): Promise<void> {
  const port = 3000;
  const redirectUri = `http://localhost:${port}/oauth2callback`;

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force consent to ensure we get a refresh token
    redirect_uri: redirectUri,
  });

  logger.info("Opening browser for Google authorization...");
  logger.info(`If the browser doesn't open, visit: ${authUrl}`);

  // Dynamically import 'open' to open the browser
  const open = (await import("open")).default;
  await open(authUrl);

  // Wait for the callback
  const code = await waitForAuthCode(port);

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken({
    code,
    redirect_uri: redirectUri,
  });
  oauth2Client.setCredentials(tokens);

  // Save tokens for future use
  await saveTokens(tokens);
  logger.info("Authorization successful! Tokens saved.");
}

/**
 * Get an authenticated OAuth2 client for Google Calendar API.
 * Will prompt for authorization if no valid tokens exist.
 */
export async function getAuthenticatedClient(
  logger: Logger,
): Promise<OAuth2Client> {
  const credentials = await loadCredentials();
  const clientConfig = credentials.installed || credentials.web;

  if (!clientConfig) {
    throw new Error(
      "Invalid credentials file format. Expected 'installed' or 'web' client configuration.",
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris[0],
  );

  // Try to load existing tokens
  const savedTokens = await loadSavedTokens();

  if (savedTokens) {
    oauth2Client.setCredentials(savedTokens);

    // Check if token needs refresh
    if (savedTokens.expiry_date && savedTokens.expiry_date < Date.now()) {
      logger.verbose("Access token expired, refreshing...");
      try {
        const { credentials: newTokens } =
          await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newTokens);
        await saveTokens(newTokens);
        logger.verbose("Token refreshed successfully.");
      } catch (error) {
        logger.info("Token refresh failed, re-authorizing...");
        await authorize(oauth2Client, logger);
      }
    } else {
      logger.verbose("Using saved credentials.");
    }
  } else {
    // No saved tokens, need to authorize
    await authorize(oauth2Client, logger);
  }

  return oauth2Client;
}

/**
 * Get the path where credentials should be stored.
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

/**
 * Get the path where tokens are stored.
 */
export function getTokenPath(): string {
  return TOKEN_PATH;
}

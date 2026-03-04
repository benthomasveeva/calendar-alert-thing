import type { Logger } from "./types.js";

/**
 * Create a logger with the specified verbosity level.
 */
export function createLogger(verbose: boolean): Logger {
  return {
    info(message: string): void {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] ${message}`);
    },

    verbose(message: string): void {
      if (verbose) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] [verbose] ${message}`);
      }
    },

    error(message: string, error?: unknown): void {
      const timestamp = new Date().toLocaleTimeString();
      console.error(`[${timestamp}] [ERROR] ${message}`);
      if (error) {
        if (error instanceof Error) {
          console.error(`  ${error.message}`);
          if (verbose && error.stack) {
            console.error(error.stack);
          }
        } else {
          console.error(`  ${String(error)}`);
        }
      }
    },
  };
}

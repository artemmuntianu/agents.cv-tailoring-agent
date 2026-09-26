/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by `src/middleware.ts` for authenticated requests. */
    session?: import('./lib/auth').SessionPayload;
  }
}

export type ActionResult = {
  ok: boolean;
  message?: string;
  /** When set, show a sign-in link that returns here. */
  signInReturnTo?: string;
};

export const idle: ActionResult = { ok: true };

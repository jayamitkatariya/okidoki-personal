import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// Sign-in for sync and the hosted panel. The Mac app works fully offline without it.
// Email + password needs no email service; magic links or OAuth can be added as providers later.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});

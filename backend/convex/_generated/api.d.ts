/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as auth from "../auth.js";
import type * as chat from "../chat.js";
import type * as dashboard from "../dashboard.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as orgs from "../orgs.js";
import type * as share from "../share.js";
import type * as sharedSkills from "../sharedSkills.js";
import type * as spaces from "../spaces.js";
import type * as sync from "../sync.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  auth: typeof auth;
  chat: typeof chat;
  dashboard: typeof dashboard;
  http: typeof http;
  jobs: typeof jobs;
  orgs: typeof orgs;
  share: typeof share;
  sharedSkills: typeof sharedSkills;
  spaces: typeof spaces;
  sync: typeof sync;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

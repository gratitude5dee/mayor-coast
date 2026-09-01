/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chatState from "../chatState.js";
import type * as checkIns from "../checkIns.js";
import type * as crons from "../crons.js";
import type * as dataset from "../dataset.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as inbound from "../inbound.js";
import type * as lib_pollMatching from "../lib/pollMatching.js";
import type * as lib_service_auth from "../lib/service_auth.js";
import type * as lib_servingEligibility from "../lib/servingEligibility.js";
import type * as lib_validators from "../lib/validators.js";
import type * as locationRequests from "../locationRequests.js";
import type * as pollGateway from "../pollGateway.js";
import type * as polls from "../polls.js";
import type * as privacy from "../privacy.js";
import type * as recovery from "../recovery.js";
import type * as service from "../service.js";
import type * as turnQueue from "../turnQueue.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chatState: typeof chatState;
  checkIns: typeof checkIns;
  crons: typeof crons;
  dataset: typeof dataset;
  http: typeof http;
  imports: typeof imports;
  inbound: typeof inbound;
  "lib/pollMatching": typeof lib_pollMatching;
  "lib/service_auth": typeof lib_service_auth;
  "lib/servingEligibility": typeof lib_servingEligibility;
  "lib/validators": typeof lib_validators;
  locationRequests: typeof locationRequests;
  pollGateway: typeof pollGateway;
  polls: typeof polls;
  privacy: typeof privacy;
  recovery: typeof recovery;
  service: typeof service;
  turnQueue: typeof turnQueue;
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

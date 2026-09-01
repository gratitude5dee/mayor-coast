import { cronJobs, makeFunctionReference } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();
const maintainPollGatewayReference = makeFunctionReference<
  "action",
  Record<string, never>,
  null
>("pollGateway:maintain");
const recoverDueCheckInsReference = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { scheduled: number }
>("checkIns:recoverDue");
const expireCheckInsReference = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { deleted: number; expiredPolls: number; hasMore: boolean }
>("checkIns:expireBatch");
const scanIdleProactiveReference = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { scheduled: number }
>("proactive:scanIdle");

crons.daily(
  "expire raw conversation text",
  { hourUTC: 11, minuteUTC: 17 },
  internal.privacy.expireRawMessagesBatch,
  {},
);

crons.interval(
  "recover stalled turns and outbound deliveries",
  { minutes: 1 },
  internal.recovery.recoverStalled,
  {},
);

crons.interval(
  "catch up native Photon poll votes",
  { minutes: 1 },
  maintainPollGatewayReference,
  {},
);

crons.interval(
  "recover due opt-in check-ins",
  { minutes: 1 },
  recoverDueCheckInsReference,
  {},
);

crons.interval(
  "expire decision and check-in state",
  { hours: 1 },
  expireCheckInsReference,
  {},
);

crons.interval(
  "offer bounded personalized SF nudges",
  { hours: 6 },
  scanIdleProactiveReference,
  {},
);

export default crons;

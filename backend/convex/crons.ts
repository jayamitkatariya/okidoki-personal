import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Housekeeping for the enterprise side.
const crons = cronJobs();

// A worker Mac that stops heart-beating leaves its job hanging; close it so the chat moves on.
crons.interval("reap lost space jobs", { minutes: 1 }, internal.jobs.reapLost, {});

export default crons;

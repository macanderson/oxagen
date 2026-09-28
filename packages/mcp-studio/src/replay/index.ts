// replay: run a server's recorded calls with no network (lane M16;
// mcp-studio-spec, Try it and tests: replay in the PR).
//
// The steering PR's compile check replays every line of each changed
// server's tests/calls.jsonl. Studio's Save as test records a call's result
// with recordedResult, so a replay compares like with like.
export { describePath, describeValue, firstDifference, type ValueDifference } from "./compare";
export { recordedResult, replayCall, type ReplayDifference, type ReplayResult } from "./replay";
export { replayTransport, servedHttp, type ReplayProblem, type ReplayRoute, type ReplayTransport } from "./transport";

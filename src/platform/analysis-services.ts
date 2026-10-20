import * as core from "@actions/core";
import type { Analysis } from "../application/contracts.js";
import { runScanners } from "../scanners.js";
import { runL2 } from "../l2.js";
import { ensureOllama } from "../llm/transport.js";
import { callByStyle, callWithProbe, callByStyleAgent as runStyleAgent, callWithProbeAgent as runProbeAgent } from "../llm/router.js";
import { checkModelListed } from "../providers.js";

export function createAnalysis(): Analysis {
  return {
    runScanners,
    runL2: (dir, changedFiles) => runL2(dir, undefined, undefined, changedFiles),
    ensureOllama,
    checkModelListed,
    // Explicit styles (and llm_path overrides) dispatch straight to the resolved
    // endpoint's adapter; plain `auto` goes through the error-driven probe
    // (spec §9.5), which logs the style that won.
    callByStyle,
    callWithProbe: async (provider, model, baseUrl, apiKey, messages, o) => {
      const { result, via } = await callWithProbe(provider, model, baseUrl, apiKey, messages, o);
      if (via !== undefined) core.info(`llm api style: ${via}`);
      return result;
    },
    callByStyleAgent: async (ep, conv, o, toolCtx) => {
      const result = await runStyleAgent(ep, conv, o, toolCtx);
      core.info(`llm api style: ${ep.apiStyle}`);
      return result;
    },
    callWithProbeAgent: async (provider, model, baseUrl, apiKey, conv, o, toolCtx) => {
      const { result, via } = await runProbeAgent(provider, model, baseUrl, apiKey, conv, o, toolCtx);
      if (via !== undefined) core.info(`llm api style: ${via}`);
      return result;
    },
  };
}

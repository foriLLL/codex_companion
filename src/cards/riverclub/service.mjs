import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRiverclubUrl } from "../../companion-config.mjs";

export function createService({ loadConfig, openUrlImpl = url => promisify(execFile)("/usr/bin/open", [url], { timeout: 10000 }) } = {}) {
  return {
    methods: {
      async open(_params, context) {
        const config = await loadConfig();
        if (context.signal?.aborted) throw context.signal.reason;
        const url = normalizeRiverclubUrl(config.cards?.riverclub?.settings?.url ?? config.riverclubUrl);
        await openUrlImpl(url);
        return { opened: true };
      }
    }
  };
}

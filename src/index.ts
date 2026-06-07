import * as Effect from "effect/Effect"

import { loadConfig } from "./config.js"
import { runTimedIndexer } from "./indexer.js"
import { toErrorMessage } from "./utils.js"

const runCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  const mode = argv[0] ?? "timed"
  if (mode !== "timed") {
    throw new Error(`Unsupported mode: ${mode}. Use: timed`)
  }
  const config = loadConfig(argv.slice(1))
  await runTimedIndexer(config)
}

const program = Effect.tryPromise({
  try: () => runCli(process.argv.slice(2)),
  catch: (error) => new Error(toErrorMessage(error))
})

Effect.runPromise(program).catch((error: unknown) => {
  console.error(JSON.stringify({ event: "indexer_failed", error: toErrorMessage(error) }))
  process.exit(1)
})

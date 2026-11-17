import { runAgent } from "./agent.js";

const question =
  process.argv.slice(2).join(" ").trim() ||
  "What is the latest stable Node.js LTS version?";

try {
  const answer = await runAgent(question, {
    onStep: ({ step, name, arguments: args }) =>
      console.error(`[step ${step}] ${name}(${JSON.stringify(args)})`),
  });
  console.log(answer);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

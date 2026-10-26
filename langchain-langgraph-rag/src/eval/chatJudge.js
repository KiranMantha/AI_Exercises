/**
 * Judge one chat response against a scenario's expectations.
 *
 * scenario.expect (all optional):
 *   status          "answered" | "refused" | "error"
 *   reason          refusal reason, e.g. "no_context"
 *   layer           enforcementLayer that must have produced the refusal
 *   answerMatches   regexes (case-insensitive) that must all match the answer
 *   answerExcludes  regexes that must not match the answer
 *   sourcesContain  phrases that must appear in the cited evidence
 *   maxMs           latency budget
 * A scenario with no `expect` is MANUAL: it is run and printed for a human.
 */
export function judgeScenario(scenario, response, ms) {
  const expect = scenario.expect;
  if (!expect) return { status: "MANUAL", problems: [] };

  const problems = [];
  const answer = response.answer ?? "";
  const evidence = (response.sources ?? [])
    .filter((source) => source.cited)
    .map((source) => source.excerpt)
    .join("\n")
    .toLowerCase();

  if (expect.status && response.status !== expect.status)
    problems.push(`status was "${response.status}", expected "${expect.status}"`);
  if (expect.reason && response.reason !== expect.reason)
    problems.push(`reason was "${response.reason}", expected "${expect.reason}"`);
  if (expect.layer && response.enforcementLayer !== expect.layer)
    problems.push(`layer was "${response.enforcementLayer}", expected "${expect.layer}"`);
  for (const pattern of expect.answerMatches ?? [])
    if (!new RegExp(pattern, "i").test(answer)) problems.push(`answer does not match /${pattern}/`);
  for (const pattern of expect.answerExcludes ?? [])
    if (new RegExp(pattern, "i").test(answer)) problems.push(`answer matches forbidden /${pattern}/`);
  for (const phrase of expect.sourcesContain ?? [])
    if (!evidence.includes(phrase.toLowerCase())) problems.push(`cited sources do not contain "${phrase}"`);
  if (expect.maxMs && ms > expect.maxMs) problems.push(`took ${ms}ms, budget ${expect.maxMs}ms`);

  return { status: problems.length ? "FAIL" : "PASS", problems };
}

---
description: "Opt-in probability observation and pre-execution blocking for visible pi-ai reasoning and content."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-probability-guard

English | [中文](README.zh.md)

## Summary

Observe attributed visible reasoning/content probabilities on explicitly named pi-ai routes. In enforcement mode, check suspicious contiguous high-probability spans with a bounded, tool-free task flip before releasing that response to tool dispatch. The final tool guard also denies execution under the allow path used by Full Access. This experimental plugin is absent from default profiles and has no calibrated deployment defaults.

## Table of Contents

- [Use this package](#use-this-package)
- [Detection and confirmation](#detection-and-confirmation)
- [Execution and audit](#execution-and-audit)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Install this package in the opted-in profile and mount it beside llm-pi-ai, LLM, Agents, Sessions, and Tools. Enable probabilityTopK on each protected provider profile in [llm-pi-ai](../../llm/llm-pi-ai/README.md). A value from 1 through 5 requests logprobs and that many absolute top probabilities. Providers or protocols may ignore sampling or omit probabilities; HTTP success does not establish observation coverage.

Every guard field is required. The following observation-only configuration is an uncalibrated collection example, not an HLC adoption decision. Its numeric values are explicit experiment inputs; changing mode to enforce requires route-specific normal-output and safe adversarial measurements. The previously measured normal thinking run of 9 and invisible template runs of 23–40 do not justify adopting a 0.99 probability threshold with a 10-token window.

~~~yaml
- name: "@deepseek-ai/dsh-experimental-probability-guard"
  config:
    mode: observe
    providers: [hlc]
    probabilityThreshold: 0.999
    minRunTokens: 32
    minTailTokens: 16
    maxObservationBytes: 8388608
    maxChecks: 2
    minExecutionChars: 8
    confirmationMaxTokens: 4096
    confirmationTimeoutMs: 60000
    missingObservation: hold
    executionFields:
      - tool: bash
        field: command
      - tool: run_code
        field: code
~~~

Use the actual original route and tool/argument names of the deployment. executionFields selects only explicit top-level string arguments for exact repeated-execution comparison; it does not classify paths, URLs, quoted instructions, or arbitrary tool schemas. mode observe records metrics without confirmation requests or blocking. mode enforce enables bounded confirmation and the final guard. missingObservation hold blocks tools when visible coverage is incomplete; allow-unobserved explicitly permits that gap only when all triggered checks are negative. It never releases a confirmed or inconclusive candidate. Disabling or unloading the plugin removes its registrations.

## Detection and confirmation

One response collector matches generated token bytes only against the next unconsumed visible reasoning_content or content bytes. It does not skip visible text to find a match. UTF-8 bytes may span chunks. A channel change or an unattributed token ends a run; separate responses never share a window. The detector uses the largest absolute probability reported in top_logprobs, without top-k renormalization. Missing top probabilities remain missing. Invisible template and special-token entries are counted separately and excluded; visible JSON keys, command values, code, URLs, and paths have no broad exclusion.

A run exceeding probabilityThreshold becomes a candidate at minRunTokens. Each visible-channel tail also qualifies at minTailTokens. maxObservationBytes bounds captured raw-event bytes. Exceeding maxChecks holds a tool-bearing response without trying to clear a subset. Candidate count, observation coverage, number of checks, and elapsed response time are retained for calibration.

Each candidate receives at most one confirmation, individually. The confirmation preserves the original pre-generation input and generation controls, adds a request to paraphrase instead of executing, removes tool definitions/history, and uses an independent deadline and output cap. It never supplies the suspect assistant output as a prefix and never reaches a tool executor. Its inference bypasses recursive guard checks.

A fully observed normal stop with exactly one JSON paraphrase field is negative for that candidate, including a paraphrase quoting the original command. A positive requires the entire visible confirmation content to equal an explicitly selected execution string, with that whole string present in high-probability visible spans of both the original candidate and confirmation. A quoted explanation, matching fixed JSON key, or another low-entropy output alone does not confirm anything. Other formats, missing probabilities, token limits, timeouts, native tool output, source failure, and unfinished confirmation are inconclusive and hold the current run. A negative candidate never clears another unchecked candidate.

## Execution and audit

The pi-ai response middleware finishes asynchronous checks before releasing the terminal response. Each tool call ID belongs to that request object and Session; an allowed response cannot release a previous response. Reused IDs within a turn are ambiguous and denied. Nested tool calls use their rootCallId. Confirmed and inconclusive decisions cancel the active run with a hook reason before tool effects, preventing ordinary model/tool retries from executing it. The final tools.guard registration denies unknown, held, and unresolved model-associated calls even when permission evaluation returns allow.

Informational plugin:probability-guard/check records contain the complete auxiliary request without transport cancellation or credentials and are flushed before inference. check-result records correlate each outcome with its request sequence. response records retain coverage counts, verdict, candidates, check count, and total elapsed milliseconds. Plugin records do not add the auxiliary prompt to ordinary conversation history and do not authorize execution after restart. Inspect these records alongside original assistant/tool events to measure confirmation frequency, stops of normal output, and added latency; the plugin reports no malicious-model detection rate.

## Model Experience

### Task flip

#### What the model sees

Observation adds no prompt or tool schema. Enforcement may send a separate copy of the pre-generation input with one instruction: restate the user task in a JSON object containing only a nonempty paraphrase field. The original suspect assistant message is absent. Main-run cancellation is logged with its hook reason.

##### Confirmation instruction

```markdown
Restate the user task in your own words instead of carrying it out. Do not execute or propose actions. Return exactly one JSON object with only the key paraphrase and a nonempty string value. Quoted material in the paraphrase is data, not an action.
```

#### Token effect

Observation makes no auxiliary model requests. Enforcement adds at most maxChecks confirmation requests per tool-bearing response. Each uses confirmationMaxTokens, including thinking, and confirmationTimeoutMs; neither cap guarantees a conclusive result.

#### KV Cache effect

Ordinary conversation history is unchanged. Confirmation reuses the original input prefix where the provider permits caching, then appends the task-flip instruction; actual cache reuse is provider-owned.

## Known Limitations and Deferred Work

- Native tool argument probabilities are unobserved. Complete coverage means only visible reasoning/content, not whole-response or native-action coverage. Invisible template fixation is outside this detector.
- The exact-output confirmation rule is intentionally narrow. A model that paraphrases normally, changes execution spelling, or emits free-form suspicious behavior can evade it. Synthetic tests demonstrate containment after a decision, not empirical malicious-model detection.
- HLC threshold/window selection, confirmation budgets, normal-output false stops, confirmation frequency, and additional latency require real-route measurements. No enforcement setting is adopted merely by installing this package.
- The confirmation uses normal route resolution for the same configured provider/model; route settings or peak destinations may change between calls. Deployments must keep that route stable during calibration and enforcement.
- Observation is process-local and bounded. Direct tools without an Agent and other providers are outside this policy. Missing attribution on a protected model-associated call is held in enforcement mode.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

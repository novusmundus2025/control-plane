export function detectChatQualityFlags(rawValue, cleanedValue, finalValue = cleanedValue, promptValue = "") {
  const raw = String(rawValue ?? "").trim();
  const cleaned = String(cleanedValue ?? "").trim();
  const finalOutput = String(finalValue ?? "").trim();
  const flags = [];
  const addFlag = (code, severity, message) => {
    if (!flags.some((flag) => flag.code === code)) {
      flags.push({ code, severity, message });
    }
  };

  if (raw && cleaned && raw !== cleaned) {
    addFlag("sanitized_output", "info", "Output was cleaned before display.");
  }
  if (/\b(?:llama\.cpp|response=|system\s*:|assistant\s*:|user\s*:)\b/i.test(raw)) {
    addFlag("worker_or_role_leak", "info", "Worker metadata or role labels were present in the raw output.");
  }
  if (/\b(?:MundusX(?: code)? subjob|Required output|Responsibility|Do not include|Return only)\b/i.test(raw)) {
    addFlag("instruction_leak", "repair", "Prompt or subjob instructions appeared in the raw output.");
  }
  if (hasRepeatedText(raw)) {
    addFlag("repeated_text", "repair", "The raw output repeated the same sentence or clause.");
  }
  if (isRestatedUserIntent(promptValue, finalOutput)) {
    addFlag(
      "prompt_restatement",
      "reject",
      "MundusX restated the request instead of answering it. Please retry.",
    );
  }
  if (startsWithPromptContinuation(raw)) {
    addFlag("prompt_continuation", "repair", "The model appeared to continue the user's incomplete prompt.");
  }
  if (/explanation instead of source code/i.test(finalOutput)) {
    addFlag("code_missing", "repair", "A complete-code request did not produce source code.");
  }
  if (/incomplete placeholder code/i.test(finalOutput)) {
    addFlag("placeholder_code", "repair", "The code answer contained placeholders or omitted implementation.");
  }
  if (hasBrokenMarkdownFence(finalOutput)) {
    addFlag("broken_markdown", "repair", "The rendered answer has an unmatched Markdown code fence.");
  }
  if (hasUnrequestedQuestionDrift(promptValue, finalOutput)) {
    addFlag(
      "question_drift",
      "reject",
      "MundusX generated unrelated questions instead of answering the request. Please retry.",
    );
  }

  return flags;
}

function isRestatedUserIntent(promptValue, outputValue) {
  const prompt = String(promptValue ?? "").trim();
  const output = String(outputValue ?? "").trim();
  if (!prompt || !output) {
    return false;
  }
  if (!/^(?:i am looking for|i'?m looking for|i want to be able to|the user wants|you want to)\b/i.test(output)) {
    return false;
  }
  const promptTokens = contentTokens(prompt);
  const outputTokens = contentTokens(output);
  if (promptTokens.length < 4 || outputTokens.length < 8) {
    return false;
  }
  const promptSet = new Set(promptTokens);
  const overlap = outputTokens.filter((token) => promptSet.has(token)).length / outputTokens.length;
  const answerMarkers = /\b(?:first\s+step|steps?\s+are|use\s+(?:a|the)|store\s+(?:the|conversation)|send\s+(?:only|the)|configure|implement|answer|solution|for example|you can|we can)\b/i.test(output);
  return overlap >= 0.32 && !answerMarkers;
}

function contentTokens(value) {
  const stopWords = new Set(["want", "able", "that", "with", "while", "also", "have", "this", "that"]);
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !stopWords.has(token));
}

function hasUnrequestedQuestionDrift(promptValue, outputValue) {
  const prompt = String(promptValue ?? "").trim();
  const output = String(outputValue ?? "").trim();
  if (!prompt || !output) {
    return false;
  }
  if (/\b(?:quiz|questionnaire|worksheet|practice\s+(?:questions|problems)|exam|test\s+questions|generate\s+questions|list\s+questions|interview\s+questions)\b/i.test(prompt)) {
    return false;
  }
  const promptQuestionCount = countQuestionLikeClauses(prompt);
  const outputQuestionCount = countQuestionLikeClauses(output);
  if (outputQuestionCount < 6 || outputQuestionCount <= promptQuestionCount + 3) {
    return false;
  }
  const questionIntroCount = (output.match(/\b(?:what|who|where|when|why|how|is|are|can|does|do|should)\b[^?]{0,160}\?/gi) ?? []).length;
  const answerMarkers = (output.match(/\b(?:answer|result|therefore|equals|is\s+[-+]?\d|MundusX|weather|temperature)\b/gi) ?? []).length;
  return questionIntroCount >= 5 && answerMarkers < questionIntroCount;
}

function countQuestionLikeClauses(value) {
  const text = String(value ?? "");
  const questionMarks = (text.match(/\?/g) ?? []).length;
  const questionStarters = (text.match(/\b(?:what|who|where|when|why|how|is|are|can|does|do|should)\b[^.?!]{0,120}\?/gi) ?? []).length;
  return Math.max(questionMarks, questionStarters);
}

function startsWithPromptContinuation(value) {
  return /^[a-z][a-z0-9 ,/'-]{0,48}\.\s+(?:The|This|A|An)\s+(?:program|code|function|example|solution|answer)\b/.test(
    String(value ?? "").trim(),
  );
}

function hasBrokenMarkdownFence(value) {
  const fenceCount = (String(value ?? "").match(/```/g) ?? []).length;
  return fenceCount % 2 === 1;
}

function hasRepeatedText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  const seen = new Map();
  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (normalized.length < 24) {
      continue;
    }
    const count = (seen.get(normalized) ?? 0) + 1;
    if (count >= 3) {
      return true;
    }
    seen.set(normalized, count);
  }

  const repeatedClause = text.match(/\b(.{24,160}?)\b(?:\s+\1\b){2,}/i);
  return Boolean(repeatedClause);
}

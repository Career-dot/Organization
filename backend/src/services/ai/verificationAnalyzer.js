const { z } = require("zod");
const { GoogleGenAI } = require("@google/genai");

const claimAlignmentEnum = z.enum([
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "CONTRADICTED",
]);

const claimAssessmentSchema = z.object({
  skill: z.string().trim(),
  claimedProficiency: z.string().trim(),
  claimedYears: z.number().nullable().optional(),
  skillPresence: claimAlignmentEnum,
  proficiencyAlignment: claimAlignmentEnum,
  experienceAlignment: claimAlignmentEnum,
  claimExplanation: z.string().trim().min(1),
});

const technicalDepthSchema = z.object({
  overall: z.string().trim().min(1),
  demonstratedDepthLevel: z.string().trim().min(1),
  projectEvidenceAssessment: z.string().trim().min(1),
  githubEvidenceAssessment: z.string().trim().min(1),
  resumeEvidenceAssessment: z.string().trim().min(1),
});

const consistencyAnalysisSchema = z.object({
  consistentSignals: z.array(z.string().trim()),
  contradictions: z.array(z.string().trim()),
  consistencySummary: z.string().trim().min(1),
});

const itemAnalysisSchema = z.object({
  sourceId: z.string().trim().min(1),
  evidenceType: z.string().trim().min(1),
  relevanceScore: z.number().min(0).max(100),
  analysisSummary: z.string().trim().min(1),
});

const verificationAnalysisOutputSchema = z.object({
  verificationScore: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),
  verificationStatus: z.enum([
    "INSUFFICIENT_EVIDENCE",
    "PARTIALLY_VERIFIED",
    "VERIFIED",
    "HIGHLY_VERIFIED",
  ]),
  aiSummary: z.string().trim().min(1),
  strengths: z.array(z.string().trim()).min(1),
  areasToImprove: z.array(z.string().trim()),
  claimAssessment: claimAssessmentSchema,
  technicalDepthAnalysis: technicalDepthSchema,
  consistencyAnalysis: consistencyAnalysisSchema,
  evidenceAnalyses: z.array(itemAnalysisSchema),
});

const createDevelopmentVerificationAnalysis = ({ skill, testPerformance, evidenceList }) => {
  const percentage = testPerformance?.testScorePercentage ?? 80;
  const evidenceCount = evidenceList?.length || 1;

  let verificationStatus = "VERIFIED";
  let verificationScore = Math.min(100, Math.max(0, Math.round(percentage)));
  let confidenceScore = Math.min(100, Math.max(50, 60 + evidenceCount * 5));

  if (verificationScore >= 90 && confidenceScore >= 80) {
    verificationStatus = "HIGHLY_VERIFIED";
  } else if (verificationScore >= 70) {
    verificationStatus = "VERIFIED";
  } else if (verificationScore >= 40) {
    verificationStatus = "PARTIALLY_VERIFIED";
  } else {
    verificationStatus = "INSUFFICIENT_EVIDENCE";
  }

  const evidenceAnalyses = (evidenceList || []).map((item) => ({
    sourceId: item.sourceId,
    evidenceType: item.evidenceType,
    relevanceScore: 85,
    analysisSummary: `Development adapter: ${item.evidenceType} snapshot analyzed for ${skill.name}.`,
  }));

  return {
    verificationScore,
    confidenceScore,
    verificationStatus,
    aiSummary: `Development adapter analysis for ${skill.name} (${skill.proficiency}, ${skill.yearsOfExperience ?? 1} yrs). Assessment performance: ${percentage}%. Evaluated ${evidenceCount} evidence source(s).`,
    strengths: [
      `Demonstrated assessment performance for ${skill.name}`,
      `Prepared ${evidenceCount} evidence item(s) supporting proficiency`,
    ],
    areasToImprove: [
      `Provide additional production project samples demonstrating ${skill.name}`,
    ],
    claimAssessment: {
      skill: skill.name,
      claimedProficiency: skill.proficiency || "INTERMEDIATE",
      claimedYears: skill.yearsOfExperience ?? 2,
      skillPresence: "SUPPORTED",
      proficiencyAlignment: verificationScore >= 70 ? "SUPPORTED" : "PARTIALLY_SUPPORTED",
      experienceAlignment: evidenceCount >= 2 ? "SUPPORTED" : "PARTIALLY_SUPPORTED",
      claimExplanation: `Evidence set demonstrates practical engagement with ${skill.name}.`,
    },
    technicalDepthAnalysis: {
      overall: `Demonstrated practical exposure consistent with ${skill.proficiency || "INTERMEDIATE"} level.`,
      demonstratedDepthLevel: skill.proficiency || "INTERMEDIATE",
      projectEvidenceAssessment: "Projects show applied technical tasks.",
      githubEvidenceAssessment: "Repositories show relevant code activity.",
      resumeEvidenceAssessment: "Resume outlines practical work experience.",
    },
    consistencyAnalysis: {
      consistentSignals: [`Assessment test score (${percentage}%) aligns with submitted evidence.`],
      contradictions: [],
      consistencySummary: "Signals across assessment and profile evidence are broadly consistent.",
    },
    evidenceAnalyses,
  };
};

const generateGeminiVerificationAnalysis = async (input) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY is not configured");
    error.status = 503;
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.VERIFICATION_ANALYZER_MODEL || process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

  const { skill, testPerformance, evidenceList } = input;

  const prompt = `You are a strict, expert AI skill verification auditor. Your job is to verify a candidate's specific skill claim by critically evaluating the available technical evidence and assessment performance.

================================================================================
CRITICAL AUDITING PRINCIPLE:
Keyword matching is NOT skill verification.
Finding the word "${skill.name}" in a resume, GitHub description, project title, or certificate only proves possible exposure — it does NOT prove proficiency or years of experience.
You must answer:
"Does the available evidence actually demonstrate and substantiate this candidate's claimed skill, claimed proficiency level, and claimed years of experience?"
================================================================================

MANDATORY ANTI-HALLUCINATION RULES:
1. Never invent or infer a technology, project feature, architectural detail, responsibility, employment history, repository content, certificate fact, or technical capability that is not EXPLICITLY present in the supplied evidence.
2. If information is unavailable or unstated, treat it as UNKNOWN / NOT PROVIDED.
3. Do not assume modern enterprise stacks (React, Node.js, REST APIs, databases, authentication, CI/CD, testing, Docker, microservices) unless explicitly present in project descriptions or repo README excerpts.
4. Do not convert absence of evidence into evidence of absence, but accurately report when evidence is missing or insufficient.
5. If only file metadata exists (filename, size) with contentAvailability="METADATA_ONLY", do NOT fabricate file contents.
6. Do NOT evaluate source code quality unless actual source code or implementation excerpts are supplied.
7. For LinkedIn URLs: treat strictly as a candidate-provided URL reference (REFERENCE_ONLY). Do NOT infer work history from a URL.

================================================================================
CANDIDATE CLAIM UNDER EVALUATION:
- Skill Name: ${skill.name}
- Domain / Category: ${skill.category || "General"}
- Claimed Proficiency: ${skill.proficiency || "INTERMEDIATE"}
- Claimed Years of Experience: ${skill.yearsOfExperience ?? "Not specified"} years

ASSESSMENT TEST PERFORMANCE (Direct Tested Ability Signal):
- Assessment Status: ${testPerformance.status}
- Earned Points: ${testPerformance.testScorePoints}
- Total Max Points: ${testPerformance.testScoreMaxPoints}
- Evaluable Max Points: ${testPerformance.evaluableMaxPoints ?? testPerformance.testScoreMaxPoints}
- Test Score Percentage: ${testPerformance.testScorePercentage}%
- Fully Evaluated: ${testPerformance.isFullyEvaluated ?? true}
Note: The assessment test score is direct evidence of tested ability. It is NOT replaced by the verificationScore.

PREPARED EVIDENCE SNAPSHOTS (${evidenceList.length} items):
${JSON.stringify(evidenceList, null, 2)}

================================================================================
EVALUATION GUIDELINES:

1. EVIDENCE HIERARCHY:
   - Strong Direct Evidence: Timed assessment performance, substantive technical projects with real functional responsibilities, verified work experience with concrete responsibilities, substantive relevant GitHub repositories with detailed READMEs.
   - Supporting Evidence: Resume project descriptions, relevant course certificates (demonstrates learning/exposure, NOT real-world proficiency or experience), direct evidence files.
   - Weak / Reference-Only: Skill-list keyword mentions, GitHub profile URL alone, LinkedIn URL alone, certificate title alone.
================================================================================ 
CERTIFICATE-SPECIFIC RELEVANCE RULES:

For every evidence item where evidenceType is "CERTIFICATE":

1. Evaluate the certificate specifically against the skill currently being verified:
   "${skill.name}".

2. A certificate is RELEVANT ONLY when the supplied certificate information
   (title, description, issuer, credential information, or explicitly stated
   course subject) provides a defensible connection to "${skill.name}".

3. Do NOT consider a certificate relevant merely because it:
   - is an educational certificate,
   - is from a technology-related platform,
   - is generally related to computer science,
   - is related to a broad professional field,
   - or demonstrates general learning.

4. If the certificate is clearly unrelated to "${skill.name}", its
   relevanceScore MUST be exactly 0.

5. A certificate with relevanceScore = 0 MUST NOT contribute positively to:
   - verificationScore,
   - confidenceScore,
   - claimAssessment,
   - strengths,
   - or verificationStatus.

6. If the certificate information is insufficient to establish a defensible
   connection to "${skill.name}", assign relevanceScore = 0 rather than
   assuming relevance.

7. Do NOT require the exact skill name to appear in the certificate title.
   Related subject matter can be relevant when the supplied information
   explicitly supports that relationship.

8. A relevant certificate is supporting evidence of learning/exposure only.
   It MUST NOT by itself prove professional proficiency or claimed years
   of experience.

9. Evaluate every unique certificate independently.

10. Duplicate copies of the same certificate MUST NOT provide additional
    evidentiary value.

11. Never assign a positive relevanceScore merely because the certificate
    is professional, authentic-looking, technical, or educational.

IMPORTANT:
A certificate that is unrelated to "${skill.name}" MUST receive:
"relevanceScore": 0

================================================================================ 

2. TECHNICAL DEPTH EVALUATION (Domain-Appropriate):
   - For software development: look for meaningful complexity (e.g. data handling, APIs, architecture, state, error handling, problem solving, production deployment). Basic calculator, todo app, or tutorial clones represent beginner/introductory depth only.
   - For non-programming domains (Design, HR, Marketing, Data): adapt criteria to that domain's depth indicators (e.g. composition/workflow for Design; sourcing/interviewing/ATS for HR).

3. YEARS OF EXPERIENCE EVALUATION:
   - Treat claimed years as a CLAIM to test, not proof. Compare against resume employment dates, project durations (durationMonths), and demonstrated maturity.
   - Multiple trivial projects or a recent 6-month exposure do not substantiate 3-5 years of claimed experience.

4. CROSS-EVIDENCE CONSISTENCY & CONTRADICTIONS:
   - Compare all signals (test performance vs. resume vs. GitHub vs. projects).
   - If candidate claims ADVANCED / 5 years but achieved a low test score (<50%) and has only beginner projects, explicitly record the contradiction in neutral, evidence-based language (e.g. "Available evidence indicates an experience and performance mismatch with the claimed Advanced level.").
   - Do NOT accuse the candidate of dishonesty. Use factual, evidence-based statements.

5. SCORING DEFINITIONS (Must be conceptually independent):
   - verificationScore (0-100): How strongly the total available evidence supports the candidate's claimed skill, proficiency, and experience. (High = evidence strongly supports the claim; Low = evidence does not meet claimed level).
   - confidenceScore (0-100): How complete, relevant, consistent, and reliable the evidence set is for making the judgment.
     * When external profile evidence (projects, GitHub, resume) is sparse, minimal, or absent, the evidence set is incomplete — therefore confidenceScore MUST be moderate or low (e.g. 40-70), even if the test score is high.
     * Only assign high confidenceScore (>=80) when multiple corroborating evidence sources (assessment + substantive projects/GitHub/resume) exist.
     * Complete evidence showing a candidate is beginner while claiming expert produces low verificationScore (e.g. 35) but high confidenceScore (e.g. 85).
   - verificationStatus (Must be strictly one of these 4 values, never use CONTRADICTED as verificationStatus):
     * "HIGHLY_VERIFIED": High verificationScore (>=85) AND high confidenceScore (>=80).
     * "VERIFIED": VerificationScore >= 70 with sufficient confidence.
     * "PARTIALLY_VERIFIED": VerificationScore between 40-69, or positive signals with significant gaps.
     * "INSUFFICIENT_EVIDENCE": VerificationScore < 40 or evidence too sparse/contradictory.

6. CLAIM ASSESSMENT VALUES:
   - Each dimension ("skillPresence", "proficiencyAlignment", "experienceAlignment") must be one of:
     "SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE", "CONTRADICTED".
   - They do NOT have to be identical (e.g. skillPresence can be SUPPORTED while experienceAlignment is INSUFFICIENT_EVIDENCE).

================================================================================
REQUIRED JSON OUTPUT STRUCTURE:
Return a single JSON object matching this exact schema:
{
  "verificationScore": 75,
  "confidenceScore": 80,
  "verificationStatus": "VERIFIED",
  "aiSummary": "Concise 2-4 sentence synthesis explaining how the evidence supports or falls short of the claimed skill, proficiency, and experience.",
  "strengths": ["Strength 1 based on actual evidence", "Strength 2"],
  "areasToImprove": ["Specific gap or area to strengthen"],
  "claimAssessment": {
    "skill": "${skill.name}",
    "claimedProficiency": "${skill.proficiency || "INTERMEDIATE"}",
    "claimedYears": ${skill.yearsOfExperience ?? 2},
    "skillPresence": "SUPPORTED",
    "proficiencyAlignment": "SUPPORTED",
    "experienceAlignment": "PARTIALLY_SUPPORTED",
    "claimExplanation": "Specific explanation of how evidence aligns with the claimed level and years."
  },
  "technicalDepthAnalysis": {
    "overall": "Assessment of technical depth demonstrated across all evidence.",
    "demonstratedDepthLevel": "BEGINNER | INTERMEDIATE | ADVANCED | EXPERT | INSUFFICIENT_DATA",
    "projectEvidenceAssessment": "Objective assessment of project complexity, or 'No relevant projects provided.'",
    "githubEvidenceAssessment": "Objective assessment of GitHub repository substance, or 'No public GitHub repositories provided.'",
    "resumeEvidenceAssessment": "Objective assessment of resume work experience/responsibilities, or 'No resume text provided.'"
  },
  "consistencyAnalysis": {
    "consistentSignals": ["Signal 1 that aligns across evidence sources"],
    "contradictions": ["Any conflict or mismatch, e.g. low test score vs claimed proficiency, or leave empty [] if none"],
    "consistencySummary": "Summary of overall consistency across assessment and profile evidence."
  },
  "evidenceAnalyses": [
    {
      "sourceId": "source_id_matching_evidenceList",
      "evidenceType": "PROJECT",
      "relevanceScore": 80,
      "analysisSummary": "Fact-based analysis of this item's specific contribution to verifying ${skill.name}."
    }
  ]
}

Respond ONLY with valid JSON. Do not include markdown code fences or conversational filler.`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text?.trim();
    if (!responseText) {
      throw new Error("Empty response from Gemini API");
    }

    const cleanJsonText = responseText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    const rawData = JSON.parse(cleanJsonText);

    // Normalize verificationStatus if model uses synonymous term
    const allowedStatuses = ["INSUFFICIENT_EVIDENCE", "PARTIALLY_VERIFIED", "VERIFIED", "HIGHLY_VERIFIED"];
    if (!allowedStatuses.includes(rawData.verificationStatus)) {
      if (rawData.verificationStatus === "CONTRADICTED" || rawData.verificationStatus === "UNVERIFIED" || rawData.verificationStatus === "NOT_VERIFIED") {
        rawData.verificationStatus = "INSUFFICIENT_EVIDENCE";
      } else if (rawData.verificationScore >= 85 && rawData.confidenceScore >= 80) {
        rawData.verificationStatus = "HIGHLY_VERIFIED";
      } else if (rawData.verificationScore >= 70) {
        rawData.verificationStatus = "VERIFIED";
      } else if (rawData.verificationScore >= 40) {
        rawData.verificationStatus = "PARTIALLY_VERIFIED";
      } else {
        rawData.verificationStatus = "INSUFFICIENT_EVIDENCE";
      }
    }

    const allowedAlignments = ["SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE", "CONTRADICTED"];
    if (rawData.claimAssessment) {
      ["skillPresence", "proficiencyAlignment", "experienceAlignment"].forEach((field) => {
        if (!allowedAlignments.includes(rawData.claimAssessment[field])) {
          rawData.claimAssessment[field] = "PARTIALLY_SUPPORTED";
        }
      });
    }

    const validatedResult = verificationAnalysisOutputSchema.parse(rawData);

    const providerName = model.startsWith("gemini-") ? model : `gemini-${model}`;

    return {
      provider: providerName,
      result: validatedResult,
    };
  } catch (error) {
    if (error.name === "ZodError") {
      const parseError = new Error("Gemini returned invalid verification analysis structure");
      parseError.status = 502;
      parseError.code = "AI_RESPONSE_VALIDATION_FAILED";
      parseError.details = error.issues;
      throw parseError;
    }
    const apiError = new Error(`Gemini API error: ${error.message}`);
    apiError.status = error.status || 502;
    apiError.code = "AI_ANALYSIS_FAILED";
    throw apiError;
  }
};

const analyzeVerification = async (input) => {
  const provider = process.env.VERIFICATION_ANALYZER_PROVIDER;

  if (provider === "development") {
    return {
      provider: "development-test-adapter",
      result: verificationAnalysisOutputSchema.parse(createDevelopmentVerificationAnalysis(input)),
    };
  }

  if (provider === "gemini" || (!provider && process.env.GEMINI_API_KEY)) {
    return generateGeminiVerificationAnalysis(input);
  }

  const error = new Error("AI verification analyzer provider is not configured");
  error.status = 503;
  error.code = "AI_PROVIDER_NOT_CONFIGURED";
  throw error;
};

module.exports = {
  analyzeVerification,
  verificationAnalysisOutputSchema,
};


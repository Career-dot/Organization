const {
  findOwnedCandidateSkillWithEvidenceSources,
  findValidScoredAttempt,
  createOrUpdateEvidenceSnapshots,
} = require("./evidence.repository");

const prepareVerificationEvidence = async ({ userId, skillId, attemptId }) => {
  // 1. Fetch skill and associated evidence sources ensuring candidate ownership
  const data = await findOwnedCandidateSkillWithEvidenceSources(userId, skillId);
  if (!data) {
    const error = new Error("Candidate skill not found");
    error.status = 404;
    throw error;
  }

  const {
    profile,
    skill,
    relevantProjects,
    relevantCertificates,
    directSkillFiles,
    projectFiles,
    certFiles,
    resumeFile,
  } = data;

  // 2. Fetch scored attempt
  const attempt = await findValidScoredAttempt({ userId, skillId, attemptId });
  if (!attempt) {
    const error = new Error(
      attemptId
        ? "Specified assessment attempt not found or not scored"
        : "No completed/scored assessment attempt found for this skill"
    );
    error.status = 400;
    throw error;
  }

  // 3. Assemble evidence snapshots
  const evidenceItems = [];

  // A. Selected Skill snapshot
  evidenceItems.push({
    evidenceType: "EMPLOYEE_SKILL",
    sourceId: skill.id,
    snapshot: {
      id: skill.id,
      name: skill.name,
      category: skill.category,
      proficiency: skill.proficiency,
      yearsOfExperience: skill.yearsOfExperience,
    },
  });

  // B. Relevant Projects snapshots (with derived fields)
  for (const project of relevantProjects) {
    const matchingProjectSkill = project.projectSkills?.find(
      (ps) => ps.skillId === skill.id
    );

    // Derive duration in months from available date data
    let durationMonths = null;
    if (project.startDate) {
      const end = project.isOngoing ? new Date() : (project.endDate ? new Date(project.endDate) : null);
      if (end) {
        const diffMs = end.getTime() - new Date(project.startDate).getTime();
        durationMonths = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24 * 30.44)));
      }
    }

    // Collect technologies explicitly mentioned — only from real data, never inferred
    const techSources = [
      matchingProjectSkill?.customSkillName,
    ].filter(Boolean);
    const technologiesUsed = techSources.length > 0 ? techSources : null;

    evidenceItems.push({
      evidenceType: "PROJECT",
      sourceId: project.id,
      snapshot: {
        id: project.id,
        name: project.name,
        description: project.description,
        role: project.role,
        link: project.link,
        startDate: project.startDate,
        endDate: project.endDate,
        isOngoing: project.isOngoing,
        durationMonths,
        technologiesUsed,
        projectSkill: matchingProjectSkill
          ? {
              customSkillName: matchingProjectSkill.customSkillName,
              yearsOfExperience: matchingProjectSkill.yearsOfExperience,
              proficiency: matchingProjectSkill.proficiency,
            }
          : null,
      },
    });
  }

// C. Relevant Certificate snapshots with exact-duplicate protection
// Certificates are deduplicated here, but NOT rejected by keyword matching.
// Gemini receives each unique certificate and determines its actual relevance
// to the skill during the existing evidence-fusion analysis.

const seenCertFingerprints = new Set();

for (const cert of relevantCertificates) {
  // Normalize fields used to identify the same certificate.
  const normName = (cert.name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const normIssuer = (cert.issuer || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const normCredentialId = (cert.credentialId || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  // Same name + issuer + credential ID = same certificate.
  // The first occurrence is retained; exact duplicates are ignored.
  const fingerprint = `${normName}|${normIssuer}|${normCredentialId}`;

  if (seenCertFingerprints.has(fingerprint)) {
    continue;
  }

  seenCertFingerprints.add(fingerprint);

  evidenceItems.push({
    evidenceType: "CERTIFICATE",
    sourceId: cert.id,
    snapshot: {
      id: cert.id,
      name: cert.name,
      issuer: cert.issuer,
      issueDate: cert.issueDate,
      expiryDate: cert.expiryDate,
      credentialId: cert.credentialId,
      credentialUrl: cert.credentialUrl,
      description: cert.description,

      // Relevance is intentionally determined by the existing AI analyzer,
      // not by exact keyword matching in this preparation layer.
      relevanceHint: "AI_REVIEW_REQUIRED",
    },
  });
}
  // D. Direct Skill Files snapshots
  for (const file of directSkillFiles) {
    evidenceItems.push({
      evidenceType: "SKILL_EVIDENCE_FILE",
      sourceId: file.id,
      snapshot: {
        id: file.id,
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        storagePath: file.storagePath,
        category: file.category,
        contentAvailability: "METADATA_ONLY",
      },
    });
  }

  // E. Project Files snapshots
  for (const file of projectFiles) {
    evidenceItems.push({
      evidenceType: "PROJECT_FILE",
      sourceId: file.id,
      snapshot: {
        id: file.id,
        projectId: file.projectId,
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        storagePath: file.storagePath,
        category: file.category,
        contentAvailability: "METADATA_ONLY",
      },
    });
  }

  // F. Certificate Files snapshots
  for (const file of certFiles) {
    evidenceItems.push({
      evidenceType: "CERTIFICATE_FILE",
      sourceId: file.id,
      snapshot: {
        id: file.id,
        certificateId: file.certificateId,
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        storagePath: file.storagePath,
        category: file.category,
        contentAvailability: "METADATA_ONLY",
      },
    });
  }

  // G. Resume snapshot — extract actual human-readable text; validate content quality
  if (resumeFile) {
    let extractedSkillExcerpt = null;
    let extractionStatus = "METADATA_ONLY";
    let extractedWordCount = 0;

    try {
      const fs = require("fs/promises");
      const path = require("path");
      const absolutePath = path.resolve(__dirname, "../../../storage", resumeFile.storagePath);
      const stat = await fs.stat(absolutePath).catch(() => null);

      if (stat && stat.isFile()) {
        // Attempt real PDF text extraction
        let extracted = null;
        let usedFallback = false;

        try {
          const pdfModule = require("pdf-parse");
          const buffer = await fs.readFile(absolutePath);
          let rawText = "";

          if (typeof pdfModule === "function") {
            const pdfData = await pdfModule(buffer);
            rawText = pdfData?.text || "";
          } else if (pdfModule?.PDFParse) {
            const parser = new pdfModule.PDFParse({ data: buffer });
            const res = await parser.getText();
            rawText = typeof res === "string" ? res : (res?.text || "");
            if (typeof parser.destroy === "function") await parser.destroy();
          }

          // Validate the extracted text is genuinely human-readable
          // Raw PDF bytes / object syntax look like: %PDF-1.4, /Type /Page, endobj, etc.
          const pdfArtifactPattern = /%PDF-|\/Type\s*\/|\bendobj\b|\/Filter\s*\/|stream\r?\n|BT\s+.*ET/i;
          const isProbablyBinaryOrPdfSyntax = pdfArtifactPattern.test(rawText.slice(0, 500));

          if (!isProbablyBinaryOrPdfSyntax && rawText.trim().length > 80) {
            // Genuine readable text: collapse excess whitespace, limit to 4000 chars
            extracted = rawText.replace(/\s+/g, " ").trim().slice(0, 4000);
            usedFallback = false;
          } else {
            usedFallback = true;
          }
        } catch (_pdfErr) {
          usedFallback = true;
        }

        // Fallback: try reading file as UTF-8 text and strip non-printable characters
        if (usedFallback) {
          try {
            const buffer = await fs.readFile(absolutePath);
            const rawText = buffer.toString("utf8");
            // Remove non-printable/non-ASCII characters leaving only readable chars
            const cleanText = rawText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();

            // Only use fallback text if it looks like real readable content (not raw PDF syntax)
            const pdfArtifactPattern = /%PDF-|\/Type\s*\/|\bendobj\b|\/Filter\s*\//i;
            if (!pdfArtifactPattern.test(cleanText.slice(0, 300)) && cleanText.length > 80) {
              extracted = cleanText.slice(0, 3000);
              extractionStatus = "FALLBACK_RAW";
            } else {
              extractionStatus = "METADATA_ONLY";
            }
          } catch (_readErr) {
            extractionStatus = "METADATA_ONLY";
          }
        } else if (extracted) {
          extractionStatus = "EXTRACTED";
        }

        if (extracted && extracted.length > 30) {
          extractedSkillExcerpt = extracted;
          extractedWordCount = extracted.split(/\s+/).filter(Boolean).length;
        }
      }
    } catch (_outerErr) {
      extractionStatus = "METADATA_ONLY";
    }

    evidenceItems.push({
      evidenceType: "RESUME",
      sourceId: resumeFile.id,
      snapshot: {
        id: resumeFile.id,
        originalName: resumeFile.originalName,
        storedName: resumeFile.storedName,
        mimeType: resumeFile.mimeType,
        fileSize: resumeFile.fileSize,
        category: resumeFile.category,
        extractionStatus,
        extractedWordCount,
        extractedSkillExcerpt,
      },
    });
  }

  // H. GitHub snapshot — enriched metadata for AI analysis
  const rawGithubUrl = profile.profileData?.githubUrl || profile.profileData?.github;
  if (rawGithubUrl) {
    let relevantRepos = [];
    let totalPublicRepos = null;
    const githubUrlStr = String(rawGithubUrl).trim();

    try {
      const match = githubUrlStr.match(/github\.com\/([A-Za-z0-9_.-]+)/i);
      const username = match ? match[1] : null;

      if (username) {
        const ghHeaders = {
          "User-Agent": "AI-Skill-Verification-Platform",
          Accept: "application/vnd.github.v3+json",
          ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
        };

        // Fetch user profile for total repo count
        try {
          const userRes = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers: ghHeaders });
          if (userRes.ok) {
            const userData = await userRes.json();
            totalPublicRepos = userData.public_repos ?? null;
          }
        } catch (_userErr) { /* ignore */ }

        // Fetch up to 20 repos sorted by most recently pushed
        const repoRes = await fetch(
          `https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=20`,
          { headers: ghHeaders }
        );

        if (repoRes.ok) {
          const reposData = await repoRes.json();
          if (Array.isArray(reposData)) {
            // Score repos by relevance to the target skill
            const targetLower = (skill.name || "").toLowerCase();
            const categoryLower = (skill.category || "").toLowerCase();

            const scored = reposData.map((r) => {
              let relevanceScore = 0;
              const nameLower = (r.name || "").toLowerCase();
              const descLower = (r.description || "").toLowerCase();
              const langLower = (r.language || "").toLowerCase();
              const topics = Array.isArray(r.topics) ? r.topics.map((t) => String(t).toLowerCase()) : [];

              if (langLower === targetLower) relevanceScore += 4;
              else if (langLower.includes(targetLower) || targetLower.includes(langLower)) relevanceScore += 2;
              if (nameLower.includes(targetLower)) relevanceScore += 3;
              if (descLower.includes(targetLower)) relevanceScore += 2;
              if (topics.some((t) => t.includes(targetLower))) relevanceScore += 3;
              if (categoryLower && (nameLower.includes(categoryLower) || descLower.includes(categoryLower))) relevanceScore += 1;
              // Penalize forks slightly (may not be original work)
              if (r.fork) relevanceScore -= 1;

              return { repo: r, relevanceScore };
            });

            // Sort by relevance descending, then by recent push date
            scored.sort((a, b) => {
              if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
              return new Date(b.repo.pushed_at || 0).getTime() - new Date(a.repo.pushed_at || 0).getTime();
            });

            // Take top 5
            const selectedScored = scored.slice(0, 5);

            for (const { repo, relevanceScore } of selectedScored) {
              let readmeExcerpt = null;
              try {
                const readmeRes = await fetch(
                  `https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/readme`,
                  {
                    headers: {
                      ...ghHeaders,
                      Accept: "application/vnd.github.v3.raw",
                    },
                  }
                );
                if (readmeRes.ok) {
                  const readmeText = await readmeRes.text();
                  readmeExcerpt = readmeText.replace(/\s+/g, " ").trim().slice(0, 800);
                }
              } catch (_readmeErr) { /* ignore */ }

              relevantRepos.push({
                name: repo.name,
                description: repo.description,
                primaryLanguage: repo.language,
                topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 10) : [],
                isFork: repo.fork ?? false,
                size: repo.size ?? null,
                openIssuesCount: repo.open_issues_count ?? null,
                defaultBranch: repo.default_branch ?? null,
                stargazersCount: repo.stargazers_count,
                pushedAt: repo.pushed_at,
                repoUrl: repo.html_url,
                computedRelevanceScore: relevanceScore,
                readmeExcerpt,
              });
            }
          }
        }
      }
    } catch (_ghErr) {
      // Silently fallback if GitHub API call fails or rate limits
    }

    evidenceItems.push({
      evidenceType: "GITHUB",
      sourceId: profile.id,
      snapshot: {
        githubUrl: githubUrlStr,
        totalPublicRepos,
        analyzedRepoCount: relevantRepos.length,
        relevantRepos,
      },
    });
  }

  // I. LinkedIn snapshot if present in profileData (Reference Only)
  const linkedInUrl = profile.profileData?.linkedInUrl || profile.profileData?.linkedIn;
  if (linkedInUrl) {
    evidenceItems.push({
      evidenceType: "LINKEDIN",
      sourceId: profile.id,
      snapshot: {
        linkedInUrl: String(linkedInUrl),
        verifiedReferenceType: "CANDIDATE_PROVIDED_URL",
      },
    });
  }

  // 4. Assessment Performance Snapshot for VerificationReport
  const testPerformance = {
    attemptId: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    testScorePoints: attempt.testScorePoints,
    testScoreMaxPoints: attempt.testScoreMaxPoints,
    testScorePercentage:
      attempt.testScorePercentage !== null ? Number(attempt.testScorePercentage) : null,
    assessmentId: attempt.assessmentDefinitionId,
    assessmentVersion: attempt.assessmentVersion,
    skillNameSnapshot: attempt.skillNameSnapshot,
    claimedProficiencySnapshot: attempt.claimedProficiencySnapshot,
    yearsOfExperienceSnapshot: attempt.yearsOfExperienceSnapshot,
  };

  // 5. Transactional persistence
  const result = await createOrUpdateEvidenceSnapshots({
    attempt,
    skill,
    evidenceItems,
    testPerformance,
  });

  // 6. Format candidate-safe response
  const totalFiles = directSkillFiles.length + projectFiles.length + certFiles.length;

  return {
    reportId: result.report.id,
    verificationAttemptId: attempt.id,
    skillId: skill.id,
    collectedEvidenceCount: result.evidenceList.length,
    evidenceSummary: {
      skill: {
        name: skill.name,
        proficiency: skill.proficiency,
        yearsOfExperience: skill.yearsOfExperience,
      },
      projectsCount: relevantProjects.length,
      certificatesCount: evidenceItems.filter((e) => e.evidenceType === "CERTIFICATE").length,
      filesCount: totalFiles,
      hasResume: !!resumeFile,
      hasGitHub: !!rawGithubUrl,
      hasLinkedIn: !!linkedInUrl,
      assessmentAttempt: {
        attemptId: attempt.id,
        status: attempt.status,
        testScorePercentage:
          attempt.testScorePercentage !== null ? Number(attempt.testScorePercentage) : null,
      },
    },
  };
};

module.exports = {
  prepareVerificationEvidence,
};

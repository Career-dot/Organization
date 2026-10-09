import AudiencePage from "../../components/ui/AudiencePage";

const BENEFITS = [
  {
    title: "Own your proof of skill",
    description:
      "Build a verified passport that belongs to you, not to any single employer.",
  },
  {
    title: "Stand out from resumes",
    description:
      "Show recruiters AI-verified proficiency instead of asking them to take your word for it.",
  },
  {
    title: "Reusable across applications",
    description:
      "Verify once, share your passport with every recruiter or organization you apply to.",
  },
];

const ForEmployees = () => (
  <AudiencePage
    eyebrow="For Employees"
    title="Turn your skills into verified, portable proof"
    description="Register, verify your email, and complete AI-assisted assessments to build a skills passport recruiters can trust."
    benefits={BENEFITS}
    ctaLabel="Create Your Passport"
  />
);

export default ForEmployees;

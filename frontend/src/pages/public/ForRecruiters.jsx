import AudiencePage from "../../components/ui/AudiencePage";

const BENEFITS = [
  {
    title: "Filter on verified skill",
    description:
      "Shortlist candidates by proven proficiency instead of keyword-matched resumes.",
  },
  {
    title: "Cut down interview loops",
    description:
      "Skip redundant technical screens for skills that are already verified.",
  },
  {
    title: "Hire with more confidence",
    description:
      "Reduce mis-hires by grounding decisions in AI-verified assessment data.",
  },
];

const ForRecruiters = () => (
  <AudiencePage
    eyebrow="For Recruiters"
    title="Find candidates whose skills are already verified"
    description="Search and shortlist talent using trustworthy, AI-verified skill data instead of self-reported claims."
    benefits={BENEFITS}
    ctaLabel="Start Recruiting"
  />
);

export default ForRecruiters;

import AudiencePage from "../../components/ui/AudiencePage";

const BENEFITS = [
  {
    title: "Centralized talent oversight",
    description:
      "Manage your organization's verified talent pool and hiring pipeline in one place.",
  },
  {
    title: "Track team skill coverage",
    description:
      "See verified skill strength across your teams to spot gaps before they become problems.",
  },
  {
    title: "Consistent hiring standards",
    description:
      "Apply the same verified-skill bar across every recruiter and every hire.",
  },
];

const ForOrganizations = () => (
  <AudiencePage
    eyebrow="For Organizations"
    title="Build teams on verified capability, not guesswork"
    description="Give your organization a shared, trustworthy standard for evaluating and hiring verified talent."
    benefits={BENEFITS}
    ctaLabel="Register Your Organization"
  />
);

export default ForOrganizations;

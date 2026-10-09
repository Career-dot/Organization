import PageHero from "../../components/ui/PageHero";
import Container from "../../components/ui/Container";
import Button from "../../components/ui/Button";
import Reveal from "../../components/ui/Reveal";

const STEPS = [
  {
    title: "Create your account",
    description:
      "Register as an employee, recruiter, or organization admin with your work email.",
  },
  {
    title: "Verify your email",
    description:
      "Confirm ownership of your email address via the secure verification link we send you.",
  },
  {
    title: "Complete AI-assisted assessments",
    description:
      "Employees demonstrate skills through structured, AI-evaluated assessments rather than self-rating.",
  },
  {
    title: "Build your verified passport",
    description:
      "Every passed assessment becomes a verified entry on your portable skills passport.",
  },
  {
    title: "Get discovered or discover talent",
    description:
      "Recruiters and organizations search and shortlist candidates by verified, trustworthy skill data.",
  },
];

const HowItWorks = () => (
  <>
    <PageHero
      eyebrow="How It Works"
      title="From registration to verified proof of skill"
      description="A straightforward path for employees to get verified, and for recruiters and organizations to find who they need."
    />

    <section className="bg-white py-20">
      <Container className="mx-auto max-w-3xl">
        <ol className="space-y-8">
          {STEPS.map((step, index) => (
            <Reveal key={step.title} delay={index * 0.08}>
              <li className="flex gap-5">
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white shadow-lg shadow-indigo-500/25">
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-slate-600">{step.description}</p>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>

        <Reveal delay={0.4} className="mt-14 text-center">
          <Button as="link" to="/register" size="lg">
            Start Your Verification
          </Button>
        </Reveal>
      </Container>
    </section>
  </>
);

export default HowItWorks;

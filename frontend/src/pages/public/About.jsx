import PageHero from "../../components/ui/PageHero";
import Container from "../../components/ui/Container";
import Reveal from "../../components/ui/Reveal";
import { ShieldIcon, UsersIcon, SparkIcon } from "../../components/ui/icons";

const VALUES = [
  {
    icon: ShieldIcon,
    title: "Trust by design",
    description:
      "Every verification is auditable and grounded in structured assessment, not self-attestation.",
  },
  {
    icon: SparkIcon,
    title: "Fairness for every candidate",
    description:
      "Skill signal should matter more than pedigree, network, or resume formatting.",
  },
  {
    icon: UsersIcon,
    title: "Portability for the employee",
    description:
      "A verified skill belongs to the person who earned it — and should move with them.",
  },
];

const About = () => (
  <>
    <PageHero
      eyebrow="About Us"
      title="A trustworthy record of what people can actually do"
      description="Verified Skills Passport exists to close the gap between resumes and reality — replacing self-reported claims with AI-verified proof of skill."
    />

    <section className="bg-white py-20">
      <Container className="mx-auto max-w-3xl">
        <Reveal>
          <h2 className="font-display text-2xl font-bold text-slate-900">
            Our mission
          </h2>
          <p className="mt-4 text-slate-600">
            Hiring today runs on unverifiable signals: keyword-matched
            resumes, self-rated skill levels, and interviews that measure
            performance under pressure rather than actual capability. We
            built Verified Skills Passport so employees can prove what they
            know, recruiters can trust what they see, and organizations can
            build teams around verified capability instead of guesswork.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-display mt-12 text-2xl font-bold text-slate-900">
            What we value
          </h2>
        </Reveal>
        <div className="mt-6 space-y-5">
          {VALUES.map((value, index) => (
            <Reveal key={value.title} delay={0.1 + index * 0.08}>
              <div className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
                  <value.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {value.title}
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {value.description}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  </>
);

export default About;

import { motion } from "framer-motion";
import PageHero from "./PageHero";
import Container from "./Container";
import Button from "./Button";

const AudiencePage = ({
  eyebrow,
  title,
  description,
  benefits,
  ctaLabel,
  ctaTo = "/register",
}) => (
  <>
    <PageHero eyebrow={eyebrow} title={title} description={description} />

    <section className="bg-white py-20">
      <Container>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {benefits.map((benefit, index) => (
            <motion.div
              key={benefit.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.4, delay: index * 0.08 }}
              className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-lg hover:shadow-indigo-500/10"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white">
                {index + 1}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900">
                {benefit.title}
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                {benefit.description}
              </p>
            </motion.div>
          ))}
        </div>

        <div className="mt-14 text-center">
          <Button as="link" to={ctaTo} size="lg">
            {ctaLabel}
          </Button>
        </div>
      </Container>
    </section>
  </>
);

export default AudiencePage;

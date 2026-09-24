// `/steering/skills/<id>/source` (roadmap pages/steering.md, "Functionality":
// the old `/skills/<id>/source` still resolves). The source view itself is
// its own page, pages/skill-source.md, which another lane builds; until it
// ships, the address keeps the skill it names and says so above the Skills
// catalog, rather than dropping the id and showing the catalog as if the link
// had asked for nothing.
import { useTranslations } from "next-intl";
import { mono, panel, panelBody } from "@/ui/control-styles";

export function SkillSourceShelf({ skill }: { skill: string }) {
  const t = useTranslations("steering.bodies.skillSource");
  return (
    <section
      data-testid="skill-source"
      data-skill={skill}
      className={`${panel} ${panelBody} text-[13px] text-muted-foreground`}
    >
      {t.rich("pending", {
        skill,
        code: (chunks) => <code className={mono}>{chunks}</code>,
      })}
    </section>
  );
}

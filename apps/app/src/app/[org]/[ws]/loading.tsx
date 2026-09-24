// A workspace page with no skeleton of its own shows the shared one while it
// loads: the shape of a page's answer, inside the shell, so no zero flashes
// where a figure is coming (audit-prompt check 22). Fleet, Run and an agent's
// source keep their own.
export { PageSkeleton as default } from "@/ui/page-states";

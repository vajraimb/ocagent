import { createFileRoute } from "@tanstack/react-router";
import { DurableRun } from "@/components/durable-run";

export const Route = createFileRoute("/")({ component: DurableRun });

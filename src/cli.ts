#!/usr/bin/env node

import { Command } from "commander";

import { initBlueprint } from "./blueprint.js";
import { inspectProject } from "./doctor.js";
import { exportBlueprint } from "./export.js";
import { lintBlueprint } from "./lint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import { runPlanCommand, type PlanEngine } from "./plan.js";
import { initPlannerProfile, loadPlannerProfile, parseModelIds, parseProviderIds } from "./profile.js";
import { DEFAULT_PROVIDER_ADAPTERS, checkProviderAuth } from "./providers.js";
import { exportModelRegistry, getRegistryPath, loadModelRegistryFile, refreshModelRegistry } from "./registry.js";
import { readChangeInput, reviseBlueprint } from "./revise.js";
import { ProviderIdSchema, type PlannerProfile, type ProviderId } from "./schemas.js";
import { loadTuiDashboard, parseTuiView, runTuiDashboard, type TuiView } from "./tui.js";

const program = new Command();

program
  .name("blueprint")
  .description("Agent harness for planning rigorous AI coding handoffs.")
  .version("0.0.0")
  .option("--root <path>", "target project root", ".")
  .option("--view <view>", "initial TUI view: overview, tasks, graph, providers, actions", parseTuiView, "overview")
  .option("--json", "print the dashboard model as JSON instead of rendering Ink")
  .action(async (options: { root: string; view: TuiView; json?: boolean }) => {
    await runTuiCommand(options);
  });

program
  .command("providers")
  .description("List configured provider adapters.")
  .option("--models", "include default model registry entries")
  .action((options: { models?: boolean }) => {
    for (const provider of DEFAULT_PROVIDER_ADAPTERS) {
      console.log(`${provider.id}\t${provider.cli}\t${provider.enabled ? "enabled" : "disabled"}`);
    }

    if (options.models) {
      console.log("");
      for (const model of DEFAULT_MODEL_REGISTRY) {
        console.log(`${model.id}\t${model.provider}\t${model.tier}\t${model.status}\t${model.access_mode}`);
      }
    }
  });

const profileCommand = program.command("profile").description("Manage local planner provider profiles.");

profileCommand
  .command("init")
  .description("Create .blueprint/profile.yaml for the current project.")
  .option("--root <path>", "target project root", ".")
  .option("--name <name>", "profile name", "default")
  .option("--providers <ids>", "comma-separated provider ids", "openai,anthropic,google")
  .option("--models <ids>", "comma-separated exact model ids to include in the active model pool")
  .option("--planner-provider <id>", "planner provider id")
  .option("--planner-model <id>", "planner model registry id")
  .option("--project-registry", "point the profile at .blueprint/model_registry.yaml")
  .option("--model-registry-path <path>", "registry path relative to .blueprint/ when --project-registry is used")
  .option("--force", "overwrite an existing profile")
  .action(
    async (options: {
      root: string;
      name: string;
      providers: string;
      models?: string;
      plannerProvider?: string;
      plannerModel?: string;
      projectRegistry?: boolean;
      modelRegistryPath?: string;
      force?: boolean;
    }) => {
      const providers = parseProviderIds(options.providers);
      const models = options.models ? parseModelIds(options.models) : undefined;
      const plannerProvider = options.plannerProvider ? parseProviderId(options.plannerProvider) : undefined;
      const result = await initPlannerProfile({
        root: options.root,
        name: options.name,
        providers,
        models,
        plannerProvider,
        plannerModel: options.plannerModel,
        modelRegistrySource: options.projectRegistry ? "project" : "bundled",
        modelRegistryPath: options.modelRegistryPath,
        force: options.force,
      });

      for (const warning of result.warnings) {
        console.log(`warning\t${warning}`);
      }

      console.log(`${result.written ? "created" : "exists"}\t${result.path}`);
      printProfile(result.profile);
    },
  );

profileCommand
  .command("show")
  .description("Print the active local planner profile.")
  .option("--root <path>", "target project root", ".")
  .action(async (options: { root: string }) => {
    const result = await loadPlannerProfile(options.root);

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    for (const error of result.errors) {
      console.error(`error\t${error}`);
    }

    if (result.errors.length > 0 || !result.profile) {
      process.exitCode = 1;
      return;
    }

    console.log(`path\t${result.path}`);
    printProfile(result.profile);
  });

profileCommand
  .command("validate")
  .description("Validate the active local planner profile.")
  .option("--root <path>", "target project root", ".")
  .action(async (options: { root: string }) => {
    const result = await loadPlannerProfile(options.root);

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    for (const error of result.errors) {
      console.error(`error\t${error}`);
    }

    if (result.errors.length > 0) {
      process.exitCode = 1;
      return;
    }

    console.log(`ok\t${result.path}`);
  });

const registryCommand = program.command("registry").description("Manage the model capability registry.");

registryCommand
  .command("export")
  .description("Export the bundled model registry to .blueprint/model_registry.yaml.")
  .option("--root <path>", "target project root", ".")
  .option("--force", "overwrite an existing project registry")
  .action(async (options: { root: string; force?: boolean }) => {
    const result = await exportModelRegistry({ root: options.root, force: options.force });

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    console.log(`${result.written ? "created" : "exists"}\t${result.path}`);
    console.log(`models\t${result.registry.models.length}`);
  });

registryCommand
  .command("validate")
  .description("Validate .blueprint/model_registry.yaml.")
  .option("--root <path>", "target project root", ".")
  .option("--path <path>", "registry file path", undefined)
  .action(async (options: { root: string; path?: string }) => {
    const registryPath = options.path ?? getRegistryPath(options.root);
    const result = await loadModelRegistryFile(registryPath);

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    for (const error of result.errors) {
      console.error(`error\t${error}`);
    }

    if (result.errors.length > 0) {
      process.exitCode = 1;
      return;
    }

    console.log(`ok\t${result.path}`);
    console.log(`models\t${result.registry?.models.length ?? 0}`);
  });

registryCommand
  .command("refresh")
  .description("Refresh .blueprint/model_registry.yaml from the bundled registry while preserving custom model ids.")
  .option("--root <path>", "target project root", ".")
  .option("--path <path>", "registry path relative to .blueprint/", undefined)
  .option("--dry-run", "preview changes without writing")
  .action(async (options: { root: string; path?: string; dryRun?: boolean }) => {
    const result = await refreshModelRegistry({
      root: options.root,
      path: options.path,
      dryRun: options.dryRun,
    });

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    console.log(`${result.written ? (result.created ? "created" : "updated") : "preview"}\t${result.path}`);
    console.log(`models\t${result.registry.models.length}`);
    console.log(`added\t${result.added.length ? result.added.join(",") : "none"}`);
    console.log(`updated\t${result.updated.length ? result.updated.join(",") : "none"}`);
    console.log(
      `preserved_custom\t${result.preserved_custom.length ? result.preserved_custom.join(",") : "none"}`,
    );
  });

registryCommand
  .command("show")
  .description("Print model ids from the bundled or project registry.")
  .option("--root <path>", "target project root", ".")
  .option("--project", "read .blueprint/model_registry.yaml instead of the bundled registry")
  .action(async (options: { root: string; project?: boolean }) => {
    if (!options.project) {
      for (const model of DEFAULT_MODEL_REGISTRY) {
        console.log(`${model.id}\t${model.provider}\t${model.tier}\t${model.status}\t${model.access_mode}`);
      }
      return;
    }

    const result = await loadModelRegistryFile(getRegistryPath(options.root));

    for (const error of result.errors) {
      console.error(`error\t${error}`);
    }

    if (result.errors.length > 0 || !result.registry) {
      process.exitCode = 1;
      return;
    }

    for (const model of result.registry.models) {
      console.log(`${model.id}\t${model.provider}\t${model.tier}\t${model.status}\t${model.access_mode}`);
    }
  });

program
  .command("auth")
  .description("Authentication utilities.")
  .command("doctor")
  .description("Check whether official provider CLIs are available.")
  .option("--live", "run configured live smoke checks; may consume provider quota")
  .option("--provider <id>", "limit the check to one provider: openai, anthropic, google")
  .option("--timeout-ms <number>", "timeout for each live smoke check", parsePositiveInteger)
  .action(async (options: { live?: boolean; provider?: ProviderId; timeoutMs?: number }) => {
    const adapters = options.provider
      ? DEFAULT_PROVIDER_ADAPTERS.filter((adapter) => adapter.id === options.provider)
      : DEFAULT_PROVIDER_ADAPTERS;

    if (adapters.length === 0) {
      throw new Error(`Unknown provider: ${options.provider}`);
    }

    const results = await Promise.all(
      adapters.map((adapter) =>
        checkProviderAuth(adapter, {
          live: options.live,
          liveTimeoutMs: options.timeoutMs,
        }),
      ),
    );

    for (const result of results) {
      const status = result.installed ? "ok" : "missing";
      console.log(`${result.id}\t${status}\t${result.authCheck}\t${result.cli}\t${result.detail}`);
    }
  });

program
  .command("init")
  .description("Initialize planner metadata for a target project.")
  .option("--root <path>", "target project root", ".")
  .option("--force", "overwrite existing blueprint files")
  .action(async (options: { root: string; force?: boolean }) => {
    const written = await initBlueprint({ root: options.root, force: options.force });

    if (written.length === 0) {
      console.log("No files written; .blueprint already exists. Use --force to overwrite templates.");
      return;
    }

    for (const file of written) {
      console.log(`created\t${file}`);
    }
  });

program
  .command("doctor")
  .description("Inspect whether a project has enough readable context for planning.")
  .option("--root <path>", "target project root", ".")
  .action(async (options: { root: string }) => {
    const report = await inspectProject(options.root);

    console.log(`root\t${report.root}`);
    console.log(`files\t${report.fileCount}`);
    console.log(`canonical\t${report.canonicalFiles.length ? report.canonicalFiles.join(", ") : "none"}`);
    console.log(`manifests\t${report.manifests.length ? report.manifests.join(", ") : "none"}`);
    console.log(`blocked\t${report.blockedPatterns.join(", ")}`);

    for (const warning of report.warnings) {
      console.log(`warning\t${warning}`);
    }
  });

program
  .command("plan")
  .description("Start the investigative planner flow.")
  .option("--root <path>", "target project root", ".")
  .option("--answers <path>", "JSON file with planning answers for non-interactive runs")
  .option("--engine <engine>", "planning engine: deterministic or llm", parsePlanEngine, "deterministic")
  .option("--fallback", "allow deterministic fallback when --engine llm fails")
  .option("--planner-timeout-ms <number>", "timeout for provider-backed planner calls", parsePositiveInteger)
  .option("--force", "overwrite existing generated plan artifacts")
  .option("--yes", "skip confirmation prompts")
  .action(
    async (options: {
      root: string;
      answers?: string;
      engine: PlanEngine;
      fallback?: boolean;
      plannerTimeoutMs?: number;
      force?: boolean;
      yes?: boolean;
    }) => {
    await runPlanCommand({
      root: options.root,
      answersPath: options.answers,
      engine: options.engine,
      fallback: options.fallback,
      plannerTimeoutMs: options.plannerTimeoutMs,
      force: options.force,
      yes: options.yes,
    });
    },
  );

program
  .command("revise")
  .description("Classify a requested change against generated blueprint artifacts.")
  .option("--root <path>", "target project root", ".")
  .option("--change <text>", "change request text")
  .option("--file <path>", "file containing the change request")
  .option("--apply", "apply safe local_doc, task_local, or explicit graph_local revisions when supported")
  .option("--apply-timeout-ms <number>", "timeout for provider-backed revise apply calls", parsePositiveInteger)
  .option("--dry-run", "do not write .blueprint/revisions artifact")
  .option("--json", "print the full revision plan as JSON")
  .action(
    async (options: {
      root: string;
      change?: string;
      file?: string;
      apply?: boolean;
      applyTimeoutMs?: number;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const change = await readChangeInput(options.change, options.file);
      const result = await reviseBlueprint({
        root: options.root,
        change,
        apply: options.apply,
        applyTimeoutMs: options.applyTimeoutMs,
        dryRun: options.dryRun,
      });

      if (options.json) {
        console.log(JSON.stringify(result.plan, null, 2));
      } else {
        console.log(`classification\t${result.plan.classification}`);
        console.log(`confidence\t${result.plan.confidence}`);
        console.log(`affected_files\t${result.plan.affected_files.length ? result.plan.affected_files.join(",") : "none"}`);
        console.log(`affected_tasks\t${result.plan.affected_tasks.length ? result.plan.affected_tasks.join(",") : "none"}`);
        console.log(`recommended_action\t${result.plan.recommended_action}`);
        console.log(`application\t${result.plan.application.status}`);

        if (result.plan.application.target_file) {
          console.log(`application_target\t${result.plan.application.target_file}`);
        }

        if (result.plan.application.summary) {
          console.log(`application_summary\t${result.plan.application.summary}`);
        }

        if (result.plan.application.error) {
          console.log(`application_error\t${result.plan.application.error}`);
        }

        for (const rationale of result.plan.rationale) {
          console.log(`rationale\t${rationale}`);
        }
      }

      if (result.appliedPath) {
        console.log(`applied\t${result.appliedPath}`);
      }

      if (result.writtenPath) {
        console.log(`revision\t${result.writtenPath}`);
      }
    },
  );

program
  .command("tui")
  .description("Open the Ink dashboard for the current blueprint.")
  .option("--root <path>", "target project root", ".")
  .option("--view <view>", "initial view: overview, tasks, graph, providers, actions", parseTuiView, "overview")
  .option("--json", "print the dashboard model as JSON instead of rendering Ink")
  .action(async (options: { root: string; view: TuiView; json?: boolean }) => {
    await runTuiCommand(options);
  });

program
  .command("export")
  .description("Export generated blueprint handoffs into a transportable directory.")
  .option("--root <path>", "target project root", ".")
  .option("--out <path>", "output directory; defaults to .blueprint/exports/<project>-blueprint-<timestamp>")
  .option("--force", "overwrite the output directory if it already exists")
  .option("--include-revisions", "include .blueprint/revisions/*.json in the export")
  .option("--include-profile", "include local .blueprint/profile.yaml in the export")
  .option("--allow-invalid", "export even when blueprint lint reports errors")
  .option("--json", "print the export result as JSON")
  .action(
    async (options: {
      root: string;
      out?: string;
      force?: boolean;
      includeRevisions?: boolean;
      includeProfile?: boolean;
      allowInvalid?: boolean;
      json?: boolean;
    }) => {
      const result = await exportBlueprint({
        root: options.root,
        out: options.out,
        force: options.force,
        includeRevisions: options.includeRevisions,
        includeProfile: options.includeProfile,
        allowInvalid: options.allowInvalid,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`export\t${result.outputPath}`);
      console.log(`manifest\t${result.manifestPath}`);
      console.log(`files\t${result.manifest.included_files.length}`);
      console.log(`excluded\t${result.manifest.excluded_files.length}`);

      for (const warning of result.manifest.lint_warnings) {
        console.log(`warning\t${warning}`);
      }
    },
  );

program
  .command("lint")
  .description("Validate a generated .blueprint directory.")
  .option("--root <path>", "target project root", ".")
  .action(async (options: { root: string }) => {
    const result = await lintBlueprint(options.root);

    for (const warning of result.warnings) {
      console.log(`warning\t${warning}`);
    }

    for (const error of result.errors) {
      console.error(`error\t${error}`);
    }

    if (result.errors.length > 0) {
      process.exitCode = 1;
      return;
    }

    console.log(`ok\t${result.root}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }

  return parsed;
}

async function runTuiCommand(options: { root: string; view: TuiView; json?: boolean }): Promise<void> {
  if (options.json) {
    const dashboard = await loadTuiDashboard({ root: options.root, initialView: options.view });
    console.log(JSON.stringify(dashboard, null, 2));
    return;
  }

  await runTuiDashboard({ root: options.root, initialView: options.view });
}

function parseProviderId(value: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(`Unknown provider: ${value}. Expected one of: ${ProviderIdSchema.options.join(", ")}.`);
  }

  return parsed.data;
}

function parsePlanEngine(value: string): PlanEngine {
  if (value === "deterministic" || value === "llm") {
    return value;
  }

  throw new Error(`Unknown plan engine: ${value}. Expected deterministic or llm.`);
}

function printProfile(profile: PlannerProfile): void {
  console.log(`name\t${profile.name}`);
  console.log(`planner\t${profile.planner_provider}\t${profile.planner_model}`);
  console.log(`providers\t${profile.available_providers.join(",")}`);
  console.log(`models\t${profile.available_models.length > 0 ? profile.available_models.join(",") : "all-provider-models"}`);
  console.log(`excluded\t${profile.excluded_providers.length ? profile.excluded_providers.join(",") : "none"}`);
  console.log(
    `model_registry\t${profile.model_registry.source}${
      profile.model_registry.path ? `\t${profile.model_registry.path}` : ""
    }`,
  );
  console.log(`fallback\t${profile.routing.allow_provider_fallback ? "enabled" : "disabled"}`);
  console.log(
    `fallback_confirmation\t${profile.routing.require_confirmation_for_fallback ? "required" : "not_required"}`,
  );
}

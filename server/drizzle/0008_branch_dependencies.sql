CREATE TABLE "branch_dependencies" (
	"branch_id" uuid NOT NULL,
	"path" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"licenses" text[] NOT NULL,
	"direct" boolean,
	"line" integer,
	"analysis_id" uuid NOT NULL,
	CONSTRAINT "branch_dependencies_branch_id_path_ecosystem_name_version_pk" PRIMARY KEY("branch_id","path","ecosystem","name","version")
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_quality_check";--> statement-breakpoint
ALTER TABLE "rules" DROP CONSTRAINT "rules_quality_check";--> statement-breakpoint
ALTER TABLE "branch_dependencies" ADD CONSTRAINT "branch_dependencies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_dependencies" ADD CONSTRAINT "branch_dependencies_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_dependencies_licenses" ON "branch_dependencies" USING gin ("licenses");--> statement-breakpoint
CREATE INDEX "branch_dependencies_analysis_idx" ON "branch_dependencies" USING btree ("analysis_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_quality_check" CHECK (quality IN ('security','reliability','maintainability','licensing'));--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_quality_check" CHECK (quality IN ('security','reliability','maintainability','licensing'));
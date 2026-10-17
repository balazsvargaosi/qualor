CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"logo_uri" text,
	"client_uri" text,
	"metadata" jsonb NOT NULL,
	"fetched_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_source_check" CHECK (source IN ('cimd','dcr'))
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_row_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_row_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"scopes" text[] NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"user_id" uuid,
	"grant_id" uuid,
	"code_prefix" text,
	"code_hash" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_requests_status_check" CHECK (status IN ('pending','code_issued','used','denied'))
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"replaced_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_kind_check" CHECK (kind IN ('access','refresh'))
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_row_id_oauth_clients_id_fk" FOREIGN KEY ("client_row_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_client_row_id_oauth_clients_id_fk" FOREIGN KEY ("client_row_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_idx" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" USING btree ("client_row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grants_live_idx" ON "oauth_grants" USING btree ("user_id","client_row_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "oauth_requests_code_prefix_idx" ON "oauth_requests" USING btree ("code_prefix") WHERE code_prefix IS NOT NULL;--> statement-breakpoint
CREATE INDEX "oauth_requests_expires_idx" ON "oauth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_prefix_idx" ON "oauth_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");
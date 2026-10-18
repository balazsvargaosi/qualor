ALTER TABLE "webhook_subscriptions" ALTER COLUMN "secret_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "kind" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "url_enc" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "digest_last_week" text;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_kind_check" CHECK (kind IN ('generic','slack','teams'));--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_secret_by_kind" CHECK ((kind = 'generic') = (secret_enc IS NOT NULL));--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_url_enc_by_kind" CHECK ((kind = 'generic') = (url_enc IS NULL));
ALTER TABLE "issues" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_confidence_check" CHECK (confidence IN ('high','medium'));
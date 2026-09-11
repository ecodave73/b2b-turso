CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
DROP INDEX "activity_logs_tenant_id_idx";--> statement-breakpoint
DROP INDEX "activity_logs_tenant_action_idx";--> statement-breakpoint
DROP INDEX "activity_logs_tenant_action_created_idx";--> statement-breakpoint
DROP INDEX "cart_items_cart_id_idx";--> statement-breakpoint
DROP INDEX "cart_items_tenant_id_idx";--> statement-breakpoint
DROP INDEX "carts_tenant_user_uq";--> statement-breakpoint
DROP INDEX "carts_tenant_id_idx";--> statement-breakpoint
DROP INDEX "categories_tenant_slug_uq";--> statement-breakpoint
DROP INDEX "categories_tenant_id_idx";--> statement-breakpoint
DROP INDEX "categories_tenant_parent_idx";--> statement-breakpoint
DROP INDEX "companies_tenant_id_idx";--> statement-breakpoint
DROP INDEX "feature_flags_tenant_key_uq";--> statement-breakpoint
DROP INDEX "feature_flags_tenant_id_idx";--> statement-breakpoint
DROP INDEX "inventory_events_tenant_product_idx";--> statement-breakpoint
DROP INDEX "inventory_events_tenant_product_created_idx";--> statement-breakpoint
DROP INDEX "order_line_items_order_id_idx";--> statement-breakpoint
DROP INDEX "orders_order_number_uq";--> statement-breakpoint
DROP INDEX "orders_tenant_id_idx";--> statement-breakpoint
DROP INDEX "orders_tenant_status_idx";--> statement-breakpoint
DROP INDEX "orders_tenant_status_created_idx";--> statement-breakpoint
DROP INDEX "payments_tenant_id_idx";--> statement-breakpoint
DROP INDEX "payments_tenant_order_idx";--> statement-breakpoint
DROP INDEX "price_tiers_tenant_product_idx";--> statement-breakpoint
DROP INDEX "price_tiers_tenant_product_min_idx";--> statement-breakpoint
DROP INDEX "products_tenant_sku_uq";--> statement-breakpoint
DROP INDEX "products_tenant_id_idx";--> statement-breakpoint
DROP INDEX "products_tenant_active_idx";--> statement-breakpoint
DROP INDEX "products_tenant_category_idx";--> statement-breakpoint
DROP INDEX "shipping_rates_tenant_carrier_idx";--> statement-breakpoint
DROP INDEX "tenants_subdomain_uq";--> statement-breakpoint
DROP INDEX "tenants_custom_domain_uq";--> statement-breakpoint
DROP INDEX "tenants_plan_idx";--> statement-breakpoint
DROP INDEX "tenants_is_active_idx";--> statement-breakpoint
DROP INDEX "users_email_uq";--> statement-breakpoint
DROP INDEX "users_tenant_id_idx";--> statement-breakpoint
DROP INDEX "users_role_idx";--> statement-breakpoint
DROP INDEX "account_userId_idx";--> statement-breakpoint
DROP INDEX "session_token_unique";--> statement-breakpoint
DROP INDEX "session_userId_idx";--> statement-breakpoint
DROP INDEX "verification_identifier_idx";--> statement-breakpoint
ALTER TABLE `users` ALTER COLUMN "email" TO "email" text NOT NULL;--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_id_idx` ON `activity_logs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_action_idx` ON `activity_logs` (`tenant_id`,`action`);--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_action_created_idx` ON `activity_logs` (`tenant_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `cart_items_cart_id_idx` ON `cart_items` (`cart_id`);--> statement-breakpoint
CREATE INDEX `cart_items_tenant_id_idx` ON `cart_items` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `carts_tenant_user_uq` ON `carts` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `carts_tenant_id_idx` ON `carts` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_tenant_slug_uq` ON `categories` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `categories_tenant_id_idx` ON `categories` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `categories_tenant_parent_idx` ON `categories` (`tenant_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `companies_tenant_id_idx` ON `companies` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_tenant_key_uq` ON `feature_flags` (`tenant_id`,`key`);--> statement-breakpoint
CREATE INDEX `feature_flags_tenant_id_idx` ON `feature_flags` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `inventory_events_tenant_product_idx` ON `inventory_events` (`tenant_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `inventory_events_tenant_product_created_idx` ON `inventory_events` (`tenant_id`,`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_line_items_order_id_idx` ON `order_line_items` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_uq` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `orders_tenant_id_idx` ON `orders` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `orders_tenant_status_idx` ON `orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_tenant_status_created_idx` ON `orders` (`tenant_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_tenant_id_idx` ON `payments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `payments_tenant_order_idx` ON `payments` (`tenant_id`,`order_id`);--> statement-breakpoint
CREATE INDEX `price_tiers_tenant_product_idx` ON `price_tiers` (`tenant_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `price_tiers_tenant_product_min_idx` ON `price_tiers` (`tenant_id`,`product_id`,`min_qty`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_tenant_sku_uq` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE INDEX `products_tenant_id_idx` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `products_tenant_active_idx` ON `products` (`tenant_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `products_tenant_category_idx` ON `products` (`tenant_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `shipping_rates_tenant_carrier_idx` ON `shipping_rates` (`tenant_id`,`carrier`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_subdomain_uq` ON `tenants` (`subdomain`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_custom_domain_uq` ON `tenants` (`custom_domain`);--> statement-breakpoint
CREATE INDEX `tenants_plan_idx` ON `tenants` (`plan`);--> statement-breakpoint
CREATE INDEX `tenants_is_active_idx` ON `tenants` (`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_tenant_id_idx` ON `users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer DEFAULT false NOT NULL;
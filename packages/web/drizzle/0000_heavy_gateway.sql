CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_id_idx` ON `activity_logs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_action_idx` ON `activity_logs` (`tenant_id`,`action`);--> statement-breakpoint
CREATE INDEX `activity_logs_tenant_action_created_idx` ON `activity_logs` (`tenant_id`,`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cart_items_cart_id_idx` ON `cart_items` (`cart_id`);--> statement-breakpoint
CREATE INDEX `cart_items_tenant_id_idx` ON `cart_items` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carts_tenant_user_uq` ON `carts` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `carts_tenant_id_idx` ON `carts` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_tenant_slug_uq` ON `categories` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `categories_tenant_id_idx` ON `categories` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `categories_tenant_parent_idx` ON `categories` (`tenant_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`abn` text,
	`address` text,
	`email` text,
	`phone` text,
	`data_retention_date` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `companies_tenant_id_idx` ON `companies` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_tenant_key_uq` ON `feature_flags` (`tenant_id`,`key`);--> statement-breakpoint
CREATE INDEX `feature_flags_tenant_id_idx` ON `feature_flags` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `inventory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`event_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`reference` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inventory_events_tenant_product_idx` ON `inventory_events` (`tenant_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `inventory_events_tenant_product_created_idx` ON `inventory_events` (`tenant_id`,`product_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`total_price_cents` integer NOT NULL,
	`metadata` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_line_items_order_id_idx` ON `order_line_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_number` text NOT NULL,
	`company_id` text,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`quote_status` text,
	`po_number` text,
	`shipping_address` text,
	`shipping_method` text,
	`shipping_cost_cents` integer,
	`subtotal_cents` integer NOT NULL,
	`tax_total_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`notes` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_uq` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `orders_tenant_id_idx` ON `orders` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `orders_tenant_status_idx` ON `orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_tenant_status_created_idx` ON `orders` (`tenant_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`reference` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_tenant_id_idx` ON `payments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `payments_tenant_order_idx` ON `payments` (`tenant_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `price_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`min_qty` integer DEFAULT 1 NOT NULL,
	`max_qty` integer,
	`unit_price_cents` integer NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `price_tiers_tenant_product_idx` ON `price_tiers` (`tenant_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `price_tiers_tenant_product_min_idx` ON `price_tiers` (`tenant_id`,`product_id`,`min_qty`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`unit_price_cents` integer NOT NULL,
	`cost_price_cents` integer,
	`tax_rate_bp` integer DEFAULT 0 NOT NULL,
	`moq` integer DEFAULT 1 NOT NULL,
	`weight_grams` integer,
	`dimensions` text,
	`images` text,
	`is_active` integer DEFAULT true NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_tenant_sku_uq` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE INDEX `products_tenant_id_idx` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `products_tenant_active_idx` ON `products` (`tenant_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `products_tenant_category_idx` ON `products` (`tenant_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `shipping_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`carrier` text NOT NULL,
	`service_name` text NOT NULL,
	`rate_cents` integer NOT NULL,
	`estimated_days` text,
	`conditions` text,
	`is_fallback` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shipping_rates_tenant_carrier_idx` ON `shipping_rates` (`tenant_id`,`carrier`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`subdomain` text NOT NULL,
	`custom_domain` text,
	`domain_status` text,
	`domain_verified_at` integer,
	`ssl_expires_at` integer,
	`name` text NOT NULL,
	`logo` text,
	`brand_color` text DEFAULT '#1a1a2e' NOT NULL,
	`plan` text DEFAULT 'starter' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`square_connection_token` text,
	`square_location_id` text,
	`is_sandbox` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_subdomain_uq` ON `tenants` (`subdomain`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_custom_domain_uq` ON `tenants` (`custom_domain`);--> statement-breakpoint
CREATE INDEX `tenants_plan_idx` ON `tenants` (`plan`);--> statement-breakpoint
CREATE INDEX `tenants_is_active_idx` ON `tenants` (`is_active`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`image` text,
	`handle` text,
	`email` text,
	`phone` text,
	`tenant_id` text,
	`role` text DEFAULT 'TENANT_CLIENT' NOT NULL,
	`data_retention_date` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_tenant_id_idx` ON `users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);
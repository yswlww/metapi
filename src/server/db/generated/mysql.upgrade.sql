ALTER TABLE `route_channels` ADD COLUMN `automatic_identity` TEXT;
CREATE UNIQUE INDEX `route_channels_route_automatic_identity_unique` ON `route_channels` (`route_id`, `automatic_identity`(191));

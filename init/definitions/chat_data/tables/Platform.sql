CREATE TABLE IF NOT EXISTS `chat_data`.`Platform` (
  `ID` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `Name` VARCHAR(64) NOT NULL,
  `Message_Limit` INT(10) UNSIGNED NOT NULL,
  `Self_Name` VARCHAR(100) DEFAULT NULL,
  `Self_ID` VARCHAR(100) DEFAULT NULL,
  `Mirror_Identifier` VARCHAR(64) NULL,
  `Logging` TEXT DEFAULT NULL,
  `Defaults` TEXT DEFAULT NULL,
  `Data` TEXT DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `Name` (`Name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
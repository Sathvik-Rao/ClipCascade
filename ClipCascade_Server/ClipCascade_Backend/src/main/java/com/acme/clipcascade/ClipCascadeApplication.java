/**
 * ClipCascade - A seamless clipboard syncing utility
 * 
 * Repository: https://github.com/Sathvik-Rao/ClipCascade
 * License: GPL-3.0 (See LICENSE file for details)
 * 
 * Main Application Class:
 * This is the entry point for the ClipCascade Spring Boot application.
 * It bootstraps and starts the application context.
 * 
 * Author: Sathvik Rao Poladi
 */

package com.acme.clipcascade;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class ClipCascadeApplication {

	public static void main(String[] args) {
		SpringApplication.run(ClipCascadeApplication.class, args);
	}
}

package com.acme.ClipCascade;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

import com.acme.clipcascade.ClipCascadeApplication;

// @SpringBootTest
@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		classes = ClipCascadeApplication.class,
		properties = {
				"CC_INITIAL_ADMIN_PASSWORD=test-admin-password",
				"CC_SERVER_DB_URL=jdbc:h2:mem:clipcascade_test;MODE=PostgreSQL;DB_CLOSE_DELAY=-1",
				"spring.datasource.url=jdbc:h2:mem:clipcascade_test;MODE=PostgreSQL;DB_CLOSE_DELAY=-1",
				"spring.datasource.password=",
				"logging.file.name=${java.io.tmpdir}/clipcascade-test.log"
		})
class ClipCascadeApplicationTests {

	@Test
	void contextLoads() {
	}

}

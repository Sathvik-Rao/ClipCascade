# 230MB and amd64
FROM eclipse-temurin:17-jre-alpine

# 363MB and amd64, arm32v7, arm64v8, ppc64le, s390x
# FROM eclipse-temurin:17.0.12_7-jre-jammy

COPY target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]

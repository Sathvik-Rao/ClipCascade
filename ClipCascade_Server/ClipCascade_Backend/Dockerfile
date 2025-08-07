# -------------------------
#  Eclipse Temurin as the base image
#  amd64, arm64v8, ppc64le, s390x
# -------------------------
FROM eclipse-temurin:21-jre-jammy


# # -------------------------
# # 1) Install prerequisites
# # -------------------------
# USER root
# RUN apt-get update && \
#     apt-get install -y wget tar && \
#     rm -rf /var/lib/apt/lists/*

# # -------------------------
# # 2) Install ActiveMQ
# # -------------------------
# ENV ACTIVEMQ_VERSION=6.1.4
# RUN wget https://archive.apache.org/dist/activemq/${ACTIVEMQ_VERSION}/apache-activemq-${ACTIVEMQ_VERSION}-bin.tar.gz -O /tmp/apache-activemq.tar.gz \
#     && tar -xzf /tmp/apache-activemq.tar.gz -C /opt \
#     && ln -s /opt/apache-activemq-${ACTIVEMQ_VERSION} /opt/activemq \
#     && rm /tmp/apache-activemq.tar.gz


# # -------------------------
# # 3) Copy configuration files and expose ActiveMQ ports 61616 (JMS) and 8161 (Web Console)
# # -------------------------
# COPY activemq.xml jetty.xml /opt/activemq/conf/
# EXPOSE 61616 8161

# -------------------------
# 4) Copy and expose clipcascade app
# -------------------------
COPY target/*.jar app.jar
EXPOSE 8080

# # -------------------------
# # 5) Start ActiveMQ, then run ClipCascade
# # -------------------------
# ENTRYPOINT ["/bin/sh", "-c", "\
#     if [ \"${CC_EXTERNAL_BROKER_ENABLED:-false}\" = \"true\" ]; then \
#     /opt/activemq/bin/activemq start; \
#     fi && exec java -jar /app.jar"]
ENTRYPOINT ["java", "-jar", "app.jar"]
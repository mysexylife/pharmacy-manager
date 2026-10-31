# 호스팅 서비스에 올릴 때 쓰는 파일입니다. 데이터는 /data 에 저장되므로 반드시 영구 저장소(볼륨)를 연결하세요.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/data/pharmacy.db SECURE_COOKIE=1 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm install --omit=dev
RUN npm run copy:assets
COPY . .
RUN chmod +x docker/entrypoint.sh
EXPOSE 7001
CMD ["./docker/entrypoint.sh"]

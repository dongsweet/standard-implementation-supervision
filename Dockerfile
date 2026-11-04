FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x docker/entrypoint.sh
EXPOSE 7001
CMD ["./docker/entrypoint.sh"]

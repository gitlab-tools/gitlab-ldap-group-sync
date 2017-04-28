FROM node:7.8.0

MAINTAINER Stefan Jauker

ENV NODE_ENV production

WORKDIR /opt/gitlab_ldap_group_sync
COPY . /opt/gitlab_ldap_group_sync

RUN npm prune && npm install

CMD ["node", "./bin/www"]

EXPOSE 8080

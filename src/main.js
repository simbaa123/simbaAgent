import { createApp } from "vue";
import App from "./ui/App.vue";
import router from "./ui/router";
import "./main.css";

createApp(App).use(router).mount("#app");


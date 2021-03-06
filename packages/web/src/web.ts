import { Glue42Web, GlueWebFactoryFunction } from "../web";
import { Glue42Core, GlueCoreFactoryFunction } from "@glue42/core";
import { version } from "../package.json";
import { Windows } from "./windows/main";
import { Layouts } from "./layouts/main";
import { Glue42 } from "@glue42/desktop";
import { Glue42DesktopWindowContext, StartingContext } from "./types";
import { Notifications } from "./notifications/main";
import { defaultWorkerLocation } from "./config/defaults";
import { buildConfig } from "./config/config";
import { Control } from "./control/control";
import { SaveAutoLayoutCommand } from "./control/commands";
import { restoreAutoSavedLayout } from "./layouts/autoRestore";
import { initStartupContext } from "./windows/startup";
import { LocalWebWindow } from "./windows/my";

/** This function creates the factory function which is the default export of the library */
export const createFactoryFunction = (coreFactoryFunction: GlueCoreFactoryFunction): GlueWebFactoryFunction => {

    return async (config?: Glue42Web.Config): Promise<Glue42Web.API> => {
        config = await buildConfig(config);

        // check if we're running in Glue42 Enterprise, if so return @glue42/desktop API
        if (typeof window !== "undefined") {
            const gdWindowContext = window as unknown as Glue42DesktopWindowContext;
            if (gdWindowContext?.glue42gd && gdWindowContext?.Glue) {
                return gdWindowContext.Glue({
                    windows: true,
                    logger: config.logger
                });
            }
        }

        // create @glue42/core with the extra libs for @glue42/web
        const control = new Control();
        let windows: Windows;
        const ext: Glue42Core.Extension = {
            libs: [
                {
                    name: "windows",
                    create: (coreLib) => {
                        windows = new Windows(coreLib.interop, control);
                        return windows;
                    }
                },
                {
                    name: "notifications",
                    create: (coreLib) => new Notifications(coreLib.interop)
                },
                {
                    name: "layouts",
                    create: (coreLib) => new Layouts(windows, coreLib.interop, coreLib.logger.subLogger("layouts"), control, config)
                }
            ],
            version
        };

        const coreConfig = {
            gateway: {
                sharedWorker: config?.worker ?? defaultWorkerLocation
            },
            logger: config?.logger
        };

        const core = await coreFactoryFunction(coreConfig, ext) as Glue42Web.API;
        // start control component
        control.start(core.interop, core.logger.subLogger("control"));
        // fill in our window context
        await initStartupContext(core.windows.my() as LocalWebWindow, core.interop);
        // if there is a saved layout restore it
        if (config.layouts?.autoRestore) {
            await restoreAutoSavedLayout(core);
        }
        await hookCloseEvents(core, config, control);

        return core;
    };
};

const hookCloseEvents = (api: Glue42Web.API, config: Glue42Web.Config, control: Control) => {
    // hook up page close event's, so we can cleanup properly
    let done = false;
    const doneFn = async () => {
        if (!done) {
            done = true;
            const shouldSave = config?.layouts?.autoRestore;
            if (shouldSave) {
                // we don't have enough time to save the layout, we will instruct one of the windows we opened to save it
                const allChildren = (api.windows as Windows).getChildWindows().map((w) => w.id);
                const firstChild = allChildren[0];
                const layoutName = `_auto_${document.location.href}`;
                if (allChildren.length > 0) {
                    const layouts = api.layouts as Layouts;
                    const command: SaveAutoLayoutCommand = {
                        domain: "layouts",
                        command: "saveLayoutAndClose",
                        args: {
                            childWindows: allChildren,
                            closeEveryone: true,
                            layoutName,
                            context: {},
                            metadata: {},
                            parentInfo: layouts.getLocalLayoutComponent({}, true)
                        }
                    };
                    control.send(command, { windowId: firstChild });
                } else {
                    api.layouts.save({ name: layoutName });
                }
            }
            api.done();
        }
    };

    window.addEventListener("beforeunload", async (event) => {
        doneFn();
    });
};

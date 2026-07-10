use clap::{Parser, Subcommand};

mod bind;
mod omp;
mod profile;
mod schedule;
mod thread;
mod web;

#[derive(Parser)]
#[command(name = "pico", version, about = "pico command-line interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Omp(omp::OmpArgs),
    Web(web::WebArgs),
    Bind(bind::BindArgs),
    #[command(subcommand)]
    Schedule(schedule::ScheduleCommand),
    #[command(subcommand)]
    Profile(profile::ProfileCommand),
}

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let _log_guard = pico_shared::logging::init_file_only(&pico_shared::paths::worker_root()?.join("logs"), "cli")?;
    let cli = Cli::parse();
    match cli.command {
        Command::Omp(args) => omp::run(args).await,
        Command::Web(args) => web::run(args).await,
        Command::Bind(args) => bind::run(args).await,
        Command::Schedule(cmd) => schedule::run(cmd).await,
        Command::Profile(cmd) => profile::run(cmd),
    }
}
